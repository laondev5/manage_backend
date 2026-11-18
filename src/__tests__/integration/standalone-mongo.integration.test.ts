import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { sha256, type OrganizationDoc, type SiteDoc } from '../../database/index.js';
import {
  createTestContext,
  insideLocation,
  TEST_PASSWORD,
  type TestAgent,
  type TestContext,
} from './harness.js';

describe('standalone MongoDB (no transactions)', () => {
  let ctx: TestContext;
  let site: SiteDoc;
  let organization: OrganizationDoc;
  let staffAgent: TestAgent;
  let staffId: string;
  let ownerId: string;

  const eventBody = (overrides: Record<string, unknown> = {}) => ({
    clientEventId: crypto.randomUUID(),
    clientShiftId: crypto.randomUUID(),
    deviceId: 'device-standalone-0001',
    siteId: site._id.toHexString(),
    type: 'CLOCK_IN',
    capturedAt: new Date().toISOString(),
    location: insideLocation(),
    sitePolicyVersion: 1,
    ...overrides,
  });

  const postEvent = (body: Record<string, unknown>, key: string = crypto.randomUUID()) =>
    staffAgent
      .post('/api/v1/attendance/events')
      .set('X-Manage-Client', 'native')
      .set('Idempotency-Key', key)
      .send(body);

  beforeAll(async () => {
    ctx = await createTestContext({}, { standalone: true });
    ownerId = await ctx.createUser('owner-standalone@example.com', 'Owner');
    staffId = await ctx.createUser('staff-standalone@example.com', 'Staff');
    organization = await ctx.createOrganization('Standalone Org', 'owner-standalone@example.com');
    site = await ctx.createSite({
      organization,
      name: 'Standalone Site',
      ownerIds: [ownerId],
      createdBy: ownerId,
    });
    await ctx.createMembership({ organization, userId: ownerId, role: 'SITE_OWNER' });
    const membership = await ctx.createMembership({
      organization,
      userId: staffId,
      role: 'STAFF',
    });
    await ctx.assign({ organization, site, userId: staffId, membership });
    staffAgent = await ctx.signIn('staff-standalone@example.com');
  });

  beforeEach(async () => {
    await ctx.c.attendanceEvents.deleteMany({});
    await ctx.c.incidents.deleteMany({});
    await ctx.c.shifts.deleteMany({});
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('detects the missing transaction support and still accepts a clock-in', async () => {
    const response = await postEvent(eventBody());
    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('ACCEPTED');
    expect(ctx.db.supportsTransactions).toBe(false);
    expect(await ctx.c.shifts.countDocuments({ userId: staffId, status: 'WORKING' })).toBe(1);
    expect(await ctx.c.attendanceEvents.countDocuments({ userId: staffId })).toBe(1);
  });

  it('returns DUPLICATE for a replay and keeps a single event', async () => {
    const body = eventBody();
    const first = await postEvent(body);
    expect(first.body.outcome).toBe('ACCEPTED');
    const replay = await postEvent(body);
    expect(replay.body.outcome).toBe('DUPLICATE');
    expect(
      await ctx.c.attendanceEvents.countDocuments({ clientEventId: body.clientEventId }),
    ).toBe(1);
  });

  it('enforces one active shift per user via the unique index', async () => {
    const first = await postEvent(eventBody());
    expect(first.body.outcome).toBe('ACCEPTED');
    const second = await postEvent(eventBody());
    expect(second.body.outcome).toBe('REJECTED');
    expect(await ctx.c.shifts.countDocuments({ userId: staffId, status: 'WORKING' })).toBe(1);
  });

  it('allows only one winner under concurrent clock-ins', async () => {
    const attempts = await Promise.all([postEvent(eventBody()), postEvent(eventBody())]);
    const accepted = attempts.filter((response) => response.body.outcome === 'ACCEPTED');
    expect(accepted).toHaveLength(1);
    expect(await ctx.c.shifts.countDocuments({ userId: staffId, status: 'WORKING' })).toBe(1);
  });

  it('clocks out and allows a fresh shift afterwards', async () => {
    const first = await postEvent(eventBody());
    expect(first.body.outcome).toBe('ACCEPTED');
    const shift = await ctx.c.shifts.findOne({ userId: staffId, status: 'WORKING' });
    expect(shift).toBeTruthy();

    const out = await postEvent({
      clientEventId: crypto.randomUUID(),
      clientShiftId: shift!.clientShiftId,
      deviceId: 'device-standalone-0001',
      siteId: site._id.toHexString(),
      type: 'CLOCK_OUT',
      capturedAt: new Date().toISOString(),
      location: insideLocation(),
      sitePolicyVersion: 1,
    });
    expect(out.body.outcome).toBe('ACCEPTED');
    expect(await ctx.c.shifts.countDocuments({ userId: staffId, status: 'WORKING' })).toBe(0);

    const fresh = await postEvent(eventBody());
    expect(fresh.body.outcome).toBe('ACCEPTED');
  });

  it('removes the eventless shift when the event insert fails, so the user is not wedged', async () => {
    // The replay precheck dedupes existing events, so a partial write only
    // happens when the event insert itself fails mid-flight. Inject that once.
    const collection = ctx.c.attendanceEvents;
    const originalInsert = collection.insertOne.bind(collection);
    let injected = false;
    collection.insertOne = ((...args: Parameters<typeof collection.insertOne>) => {
      if (!injected) {
        injected = true;
        const error = new Error('injected duplicate key') as Error & { code: number };
        error.code = 11000;
        return Promise.reject(error);
      }
      return originalInsert(...args);
    }) as typeof collection.insertOne;

    try {
      const blocked = await postEvent(eventBody());
      expect(blocked.status).toBe(409);
      expect(await ctx.c.shifts.countDocuments({ userId: staffId })).toBe(0);
    } finally {
      collection.insertOne = originalInsert;
    }

    const recovered = await postEvent(eventBody());
    expect(recovered.body.outcome).toBe('ACCEPTED');
  });

  it('accepts an invitation end-to-end without transactions', async () => {
    const token = crypto.randomUUID();
    const now = new Date();
    await ctx.c.invitations.insertOne({
      _id: new ObjectId(),
      organizationId: organization._id,
      siteId: site._id,
      email: 'invitee-standalone@example.com',
      role: 'STAFF',
      tokenHash: sha256(token),
      status: 'PENDING',
      note: null,
      createdBy: ownerId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      acceptedAt: null,
      acceptedBy: null,
    });

    const response = await staffAgent
      .post('/api/v1/invitations/accept')
      .set('origin', 'http://localhost:3000')
      .send({ token, name: 'Invited Staff', password: TEST_PASSWORD });
    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);

    const invitee = await ctx.c.users.findOne({ email: 'invitee-standalone@example.com' });
    expect(invitee).toBeTruthy();
    const inviteeId =
      typeof invitee!._id === 'string' ? invitee!._id : invitee!._id.toHexString();

    const invitation = await ctx.c.invitations.findOne({ tokenHash: sha256(token) });
    expect(invitation?.status).toBe('ACCEPTED');
    expect(invitation?.acceptedBy).toBe(inviteeId);

    const membership = await ctx.c.memberships.findOne({
      organizationId: organization._id,
      userId: inviteeId,
    });
    expect(membership?.role).toBe('STAFF');
    expect(membership?.status).toBe('ACTIVE');

    const assignment = await ctx.c.assignments.findOne({ siteId: site._id, memberId: inviteeId });
    expect(assignment).toBeTruthy();
    expect(assignment?.acceptedAt).toBeTruthy();

    await ctx.c.users.updateOne(
      { email: 'invitee-standalone@example.com' },
      { $set: { emailVerified: true, updatedAt: new Date() } },
    );
    const inviteeAgent = await ctx.signIn('invitee-standalone@example.com');
    const me = await inviteeAgent.get('/api/v1/me');
    expect(me.status).toBe(200);
  });
});