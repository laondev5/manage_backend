import '../../load-env.js';
import { createHmac } from 'node:crypto';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { pino } from 'pino';
import {
  connectDatabase,
  ensureIndexes,
  pointDoc,
  type Collections,
  type Database,
  type MembershipDoc,
  type OrganizationDoc,
  type SiteDoc,
} from '../../database/index.js';
import { createAuth } from '../../auth.js';
import { createApp } from '../../create-app.js';
import { loadEnv } from '../../env.js';
import { createMailer, type Mailer } from '../../mail.js';

export const TEST_PASSWORD = 'ManageTest!2026';
export type TestAgent = ReturnType<typeof request.agent>;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function totpCode(base32Secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const signature = createHmac('sha1', decodeBase32(base32Secret)).update(buffer).digest();
  const offset = signature[signature.length - 1]! & 0x0f;
  const binary =
    ((signature[offset]! & 0x7f) << 24) |
    ((signature[offset + 1]! & 0xff) << 16) |
    ((signature[offset + 2]! & 0xff) << 8) |
    (signature[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

export type TestContext = Awaited<ReturnType<typeof createTestContext>>;

export async function createTestContext(
  overrides: NodeJS.ProcessEnv = {},
  options: { standalone?: boolean; mailer?: Mailer } = {},
) {
  const mongo = options.standalone
    ? await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
    : await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' },
        instanceOpts: [{ launchTimeout: 60_000 }],
      });
  const uri = mongo.getUri('manage_test');
  const env = loadEnv({
    NODE_ENV: 'test',
    MONGODB_URI: uri,
    MONGODB_DB_NAME: 'manage_test',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-1234',
    AUTH_BASE_URL: 'http://localhost:4000',
    TRUSTED_WEB_ORIGINS: 'http://localhost:3000',
    MOBILE_SCHEME: 'manage',
    SEED_PASSWORD: TEST_PASSWORD,
    LOCAL_NOTIFICATION_DIR: '.data/test-notifications',
    ...overrides,
  } as NodeJS.ProcessEnv);
  const db = await connectDatabase(uri, 'manage_test');
  await ensureIndexes(db.db);

  const logger = pino({ level: 'silent' });
  const mailer = options.mailer ?? createMailer(env, logger);
  const auth = createAuth(db, env, logger, mailer);
  const app = createApp({ db, auth, env, mailer }, logger);

  const c: Collections = db.c;
  const totpSecrets = new Map<string, string>();

  async function createUser(email: string, name = 'Test Person') {
    const existing = await c.users.findOne({ email });
    if (existing) {
      const id = typeof existing._id === 'string' ? existing._id : existing._id.toHexString();
      return id;
    }
    const result = await auth.api.signUpEmail({
      body: { name, email, password: TEST_PASSWORD },
    });
    await c.users.updateOne(
      { email },
      { $set: { emailVerified: true, updatedAt: new Date() } },
    );

    const agent = request.agent(app);
    const signInResponse = await agent
      .post('/api/auth/sign-in/email')
      .set('origin', 'http://localhost:3000')
      .send({ email, password: TEST_PASSWORD });
    if (signInResponse.status !== 200) {
      throw new Error(`Unable to sign in while enrolling MFA: ${signInResponse.status} ${signInResponse.text}`);
    }

    const enable = await agent
      .post('/api/auth/two-factor/enable')
      .set('origin', 'http://localhost:3000')
      .send({ password: TEST_PASSWORD });
    if (enable.status !== 200 || !enable.body?.totpURI) {
      throw new Error(`Unable to enable MFA: ${enable.status} ${enable.text}`);
    }
    const secret = new URL(enable.body.totpURI).searchParams.get('secret');
    if (!secret) throw new Error('The TOTP URI did not contain a secret.');
    totpSecrets.set(email, secret);

    const verify = await agent
      .post('/api/auth/two-factor/verify-totp')
      .set('origin', 'http://localhost:3000')
      .send({ code: totpCode(secret) });
    if (verify.status !== 200) {
      throw new Error(`Unable to verify MFA enrollment: ${verify.status} ${verify.text}`);
    }
    await agent.post('/api/auth/sign-out').set('origin', 'http://localhost:3000');

    return result.user.id;
  }

  async function createOrganization(name: string, contactEmail: string) {
    const now = new Date();
    const organization: OrganizationDoc = {
      _id: new ObjectId(),
      name,
      status: 'ACTIVE',
      contactEmail,
      timezone: 'Africa/Lagos',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await c.organizations.insertOne(organization);
    return organization;
  }

  async function createSite(input: {
    organization: OrganizationDoc;
    name: string;
    ownerIds: string[];
    createdBy: string;
    latitude?: number;
    longitude?: number;
  }) {
    const now = new Date();
    const policy = {
      radiusMeters: 150,
      exitBufferMeters: 30,
      entryBufferMeters: 15,
      graceSeconds: 3600,
      maxAccuracyMeters: 50,
      freshnessSeconds: 120,
    };
    const site: SiteDoc = {
      _id: new ObjectId(),
      organizationId: input.organization._id,
      name: input.name,
      address: '1 Test Road, Lagos',
      location: pointDoc(input.longitude ?? 3.3841, input.latitude ?? 6.455),
      timezone: 'Africa/Lagos',
      ownerIds: input.ownerIds,
      policy,
      policyVersion: 1,
      expectedHours: { start: '08:00', end: '17:00', days: [1, 2, 3, 4, 5] },
      notificationPreferences: { email: true, push: true, onDutyAlerts: true },
      status: 'ACTIVE',
      version: 1,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await c.sites.insertOne(site);
    await c.sitePolicies.insertOne({
      _id: new ObjectId(),
      siteId: site._id,
      organizationId: input.organization._id,
      version: 1,
      policy,
      center: site.location,
      timezone: site.timezone,
      createdBy: input.createdBy,
      createdAt: now,
    });
    return site;
  }

  async function createMembership(input: {
    organization: OrganizationDoc;
    userId: string;
    role: MembershipDoc['role'];
    status?: MembershipDoc['status'];
  }) {
    const now = new Date();
    const membership: MembershipDoc = {
      _id: new ObjectId(),
      organizationId: input.organization._id,
      userId: input.userId,
      role: input.role,
      status: input.status ?? 'ACTIVE',
      title: null,
      onboarding: {
        detailsConfirmed: true,
        siteReviewed: true,
        readinessCompleted: true,
        siteDetailsDone: true,
        boundaryDone: true,
        inviteDone: true,
        alertsReviewed: true,
        completedAt: now,
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await c.memberships.insertOne(membership);
    return membership;
  }

  async function assign(input: {
    organization: OrganizationDoc;
    site: SiteDoc;
    userId: string;
    membership: MembershipDoc;
    acceptedAt?: Date | null;
  }) {
    const now = new Date();
    await c.assignments.insertOne({
      _id: new ObjectId(),
      organizationId: input.organization._id,
      siteId: input.site._id,
      memberId: input.userId,
      membershipId: input.membership._id,
      permissionScope: 'CLOCK_AND_HISTORY',
      effectiveFrom: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      effectiveTo: null,
      acceptedAt: input.acceptedAt === undefined ? now : input.acceptedAt,
      createdBy: 'test',
      endedBy: null,
      createdAt: now,
    });
  }

  async function signIn(email: string): Promise<TestAgent> {
    const agent = request.agent(app);
    const response = await agent
      .post('/api/auth/sign-in/email')
      .set('origin', 'http://localhost:3000')
      .send({ email, password: TEST_PASSWORD });
    if (response.status !== 200) {
      throw new Error(`Sign-in failed for ${email}: ${response.status} ${response.text}`);
    }
    if (response.body?.twoFactorRedirect) {
      const secret = totpSecrets.get(email);
      if (!secret) throw new Error(`No TOTP secret was enrolled for ${email}.`);
      const verify = await agent
        .post('/api/auth/two-factor/verify-totp')
        .set('origin', 'http://localhost:3000')
        .send({ code: totpCode(secret) });
      if (verify.status !== 200) {
        throw new Error(`MFA challenge failed for ${email}: ${verify.status} ${verify.text}`);
      }
    }
    const me = await agent.get('/api/v1/me');
    if (me.status !== 200) {
      throw new Error(`Session was not established for ${email}: ${me.status} ${me.text}`);
    }
    return agent;
  }

  async function close() {
    await db.close();
    await mongo.stop();
  }

  return {
    app,
    auth,
    db,
    c,
    env,
    createUser,
    createOrganization,
    createSite,
    createMembership,
    assign,
    signIn,
    close,
  };
}

export const nativeHeaders = {
  'X-Manage-Client': 'native',
  Origin: 'http://localhost:3000',
};

export const insideLocation = (offsetMeters = 0) => ({
  latitude: 6.455 + offsetMeters / 111_320,
  longitude: 3.3841,
  accuracyMeters: 10,
  capturedAt: new Date().toISOString(),
});

export function uuid(): string {
  return crypto.randomUUID();
}

export type TestDatabase = Database;
