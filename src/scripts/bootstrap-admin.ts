import '../load-env.js';
import { pino } from 'pino';
import { ObjectId } from 'mongodb';
import { connectDatabase, ensureIndexes, type Collections } from '../database/index.js';
import type { Env } from '../env.js';
import { loadEnv } from '../env.js';
import { createAuth, type Auth } from '../auth.js';

async function ensureAuthUser(
  auth: Auth,
  c: Collections,
  input: { name: string; email: string; password: string },
) {
  const existing = await c.users.findOne({ email: input.email });
  if (existing) {
    const id = typeof existing._id === 'string' ? existing._id : existing._id.toHexString();
    return { id, email: input.email, created: false };
  }
  const result = await auth.api.signUpEmail({ body: input });
  await c.users.updateOne(
    { email: input.email },
    { $set: { emailVerified: true, updatedAt: new Date() } },
  );
  return { id: result.user.id, email: input.email, created: true };
}

const usage = `Usage: pnpm bootstrap:admin -- --email admin@example.com --name "Admin Name" --password "a-long-password" [--org "Organization name"]

Creates the first platform administrator. The password must be supplied explicitly;
there is no default password. Refuses to run when a platform administrator already exists.`;

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

const noopMailer = {
  provider: 'local' as const,
  send: async () => ({ provider: 'local' as const, providerMessageId: 'bootstrap-noop' }),
};

async function findFirstOrganization(c: Collections) {
  return c.organizations.findOne({}, { sort: { createdAt: 1 } });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    return;
  }

  const email = args.email?.trim().toLowerCase();
  const name = args.name?.trim();
  const password = args.password;
  const organizationName = args.org?.trim() || 'Manage';

  if (!email || !name || !password) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  if (password.length < 12) {
    console.error('The bootstrap password must be at least 12 characters.');
    process.exitCode = 1;
    return;
  }

  const env: Env = loadEnv();
  const logger = pino({ level: 'warn' });
  const db = await connectDatabase(env.MONGODB_URI, env.MONGODB_DB_NAME);

  try {
    await ensureIndexes(db.db);

    const existingAdmin = await db.c.memberships.findOne({ role: 'PLATFORM_ADMIN', status: 'ACTIVE' });
    if (existingAdmin) {
      console.error('A platform administrator already exists. Bootstrap refuses to create another.');
      process.exitCode = 1;
      return;
    }

    const auth = createAuth(db, env, logger, noopMailer);
    const user = await ensureAuthUser(auth, db.c, { name, email, password });

    let organization = await findFirstOrganization(db.c);
    if (!organization) {
      const now = new Date();
      const organizationId = new ObjectId();
      organization = {
        _id: organizationId,
        name: organizationName,
        status: 'ACTIVE',
        contactEmail: email,
        timezone: 'Africa/Lagos',
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await db.c.organizations.insertOne(organization);
    }

    const now = new Date();
    await db.c.memberships.updateOne(
      { organizationId: organization._id, userId: user.id },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          organizationId: organization._id,
          userId: user.id,
          role: 'PLATFORM_ADMIN',
          status: 'ACTIVE',
          title: 'Platform administrator',
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
        },
      },
      { upsert: true },
    );

    console.log(`Platform administrator ready: ${email} in organization "${organization.name}".`);
    console.log('Sign in through the admin web app and enroll an authenticator before managing data.');
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  pino().error({ err: error }, 'Bootstrap failed');
  process.exit(1);
});
