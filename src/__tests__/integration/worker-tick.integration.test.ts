import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import {
  createIncidentAlerts,
  type IncidentDoc,
  type SiteDoc,
  type OrganizationDoc,
} from '../../database/index.js';
import { createTestContext, type TestContext } from './harness.js';

const SECRET = 'w'.repeat(48);
const TICK_PATH = '/api/v1/internal/worker/tick';

function tickAgent(ctx: TestContext) {
  return request(ctx.app).post(TICK_PATH).set('origin', 'http://localhost:3000');
}

async function seedOutbox(
  ctx: TestContext,
  organization: OrganizationDoc,
  site: SiteDoc,
  userId: string,
) {
  const now = new Date();
  const incident: IncidentDoc = {
    _id: new ObjectId(),
    organizationId: organization._id,
    siteId: site._id,
    shiftId: new ObjectId(),
    userId,
    state: 'CONFIRMED',
    open: true,
    detectedAt: now,
    confirmedAt: now,
    returnedAt: null,
    cancelledAt: null,
    cancelledReason: null,
    lastEvidenceAt: now,
    detectionLocation: null,
    detectionAccuracyMeters: 14,
    distanceMeters: 240,
    radiusMeters: site.policy.radiusMeters,
    policyVersion: site.policyVersion,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.c.incidents.insertOne(incident);
  const alerts = await createIncidentAlerts(ctx.c, {
    incident,
    site,
    recipients: [userId],
  });
  return { incident, alerts };
}

describe('worker endpoint with no scheduler secret configured', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('does not reveal the route', async () => {
    const response = await tickAgent(ctx).set('authorization', `Bearer ${SECRET}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

describe('Vercel cron worker tick', () => {
  let ctx: TestContext;
  const cronSecret = 'c'.repeat(48);

  beforeAll(async () => {
    ctx = await createTestContext({ CRON_SECRET: cronSecret });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('accepts a GET bearer token from the cron scheduler', async () => {
    const missing = await request(ctx.app).get(TICK_PATH);
    expect(missing.status).toBe(401);

    const response = await request(ctx.app)
      .get(TICK_PATH)
      .set('authorization', `Bearer ${cronSecret}`);
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.reconciled).toBe(true);

    const heartbeat = await ctx.c.workerHeartbeats.findOne({ _id: 'worker' });
    expect(heartbeat?.mode).toBe('scheduled');
  });

  it('keeps POST available for an external scheduler using the same secret', async () => {
    const response = await request(ctx.app)
      .post(TICK_PATH)
      .set('origin', 'http://localhost:3000')
      .set('authorization', `Bearer ${cronSecret}`);
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});

describe('scheduled worker tick', () => {
  let ctx: TestContext;
  let notificationsDir: string;
  let organization: OrganizationDoc;
  let site: SiteDoc;
  let ownerId: string;

  beforeAll(async () => {
    notificationsDir = await mkdtemp(join(tmpdir(), 'manage-worker-notify-'));
    ctx = await createTestContext({
      WORKER_TRIGGER_SECRET: SECRET,
      LOCAL_NOTIFICATION_DIR: notificationsDir,
      LOCATION_RETENTION_DAYS: '1',
    });
    ownerId = await ctx.createUser('worker-tick-owner@example.com', 'Tick Owner');
    organization = await ctx.createOrganization('Tick Org', 'tick@example.com');
    site = await ctx.createSite({
      organization,
      name: 'Tick Site',
      ownerIds: [ownerId],
      createdBy: ownerId,
    });
    await ctx.createMembership({ organization, userId: ownerId, role: 'SITE_OWNER' });
  });

  afterAll(async () => {
    await ctx.close();
    await rm(notificationsDir, { recursive: true, force: true });
  });

  it('rejects a missing or wrong secret', async () => {
    const missing = await tickAgent(ctx);
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('UNAUTHENTICATED');

    const wrong = await tickAgent(ctx).set('authorization', `Bearer ${'x'.repeat(48)}`);
    expect(wrong.status).toBe(401);

    const similarLength = await tickAgent(ctx).set('authorization', `Bearer ${SECRET.slice(0, 47)}`);
    expect(similarLength.status).toBe(401);
  });

  it('rejects an out-of-range batch size', async () => {
    const response = await tickAgent(ctx)
      .query({ max: 0 })
      .set('authorization', `Bearer ${SECRET}`);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('delivers leased items once and records a scheduled heartbeat', async () => {
    const { incident, alerts } = await seedOutbox(ctx, organization, site, ownerId);
    expect(alerts).toHaveLength(1);

    const first = await tickAgent(ctx)
      .query({ max: 10 })
      .set('authorization', `Bearer ${SECRET}`);
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.delivered).toBe(2);
    expect(first.body.failed).toBe(0);
    expect(first.body.reconciled).toBe(true);

    const items = await ctx.c.outbox.find({ incidentId: incident._id }).toArray();
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.state === 'SENT')).toBe(true);
    expect(items.every((item) => item.attempts === 1)).toBe(true);
    expect(items.every((item) => item.leaseOwner === null)).toBe(true);

    const email = items.find((item) => item.channel === 'EMAIL');
    expect(email?.providerMessageId).toMatch(/^local-/);

    const mail = await readdir(join(notificationsDir, 'mail'));
    const files = await Promise.all(mail.map((name) => readFile(join(notificationsDir, 'mail', name), 'utf8')));
    const delivered = files
      .map((content) => JSON.parse(content) as { alertId?: string; to?: string })
      .filter((message) => message.alertId === alerts[0]?._id.toHexString());
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.to).toBe('worker-tick-owner@example.com');

    const heartbeat = await ctx.c.workerHeartbeats.findOne({ _id: 'worker' });
    expect(heartbeat?.mode).toBe('scheduled');
    expect(heartbeat?.state).toBe('idle');

    const second = await tickAgent(ctx)
      .query({ max: 10 })
      .set('authorization', `Bearer ${SECRET}`);
    expect(second.status).toBe(200);
    expect(second.body.delivered).toBe(0);
  });

  it('does not double-deliver when two ticks run at the same time', async () => {
    const { incident } = await seedOutbox(ctx, organization, site, ownerId);

    const [left, right] = await Promise.all([
      tickAgent(ctx).query({ max: 10 }).set('authorization', `Bearer ${SECRET}`),
      tickAgent(ctx).query({ max: 10 }).set('authorization', `Bearer ${SECRET}`),
    ]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    expect((left.body.delivered as number) + (right.body.delivered as number)).toBe(2);

    const items = await ctx.c.outbox.find({ incidentId: incident._id }).toArray();
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.state === 'SENT')).toBe(true);
    const providerIds = new Set(items.map((item) => item.providerMessageId));
    expect(providerIds.size).toBe(2);
  });

  it('drops precise coordinates past the retention window but keeps the evidence row', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const shiftId = new ObjectId();
    const point = { type: 'Point' as const, coordinates: [3.3841, 6.455] as [number, number] };

    await ctx.c.observations.insertOne({
      _id: new ObjectId(),
      organizationId: organization._id,
      siteId: site._id,
      shiftId,
      userId: ownerId,
      clientObservationId: 'retention-observation',
      location: point,
      accuracyMeters: 8,
      capturedAt: old,
      receivedAt: old,
      source: 'BACKGROUND',
      policyVersion: 1,
      classification: 'INSIDE',
      distanceMeters: 20,
      action: 'NONE',
      createdAt: old,
    });
    await ctx.c.attendanceEvents.insertOne({
      _id: new ObjectId(),
      organizationId: organization._id,
      siteId: site._id,
      shiftId,
      userId: ownerId,
      deviceId: 'retention-device',
      clientEventId: 'retention-event',
      clientShiftId: 'retention-shift',
      type: 'CLOCK_IN',
      outcome: 'ACCEPTED',
      capturedAt: old,
      receivedAt: old,
      receivedOffsetSeconds: 0,
      location: point,
      accuracyMeters: 8,
      distanceMeters: 20,
      sitePolicyVersion: 1,
      reviewReason: null,
      note: null,
      syncState: 'ACCEPTED',
      correctionId: null,
      requestId: 'retention-test',
      createdAt: old,
    });

    const response = await tickAgent(ctx)
      .query({ max: 10 })
      .set('authorization', `Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(response.body.locationsPurged).toBe(2);

    expect(await ctx.c.observations.countDocuments({ clientObservationId: 'retention-observation' })).toBe(0);
    const event = await ctx.c.attendanceEvents.findOne({ clientEventId: 'retention-event' });
    expect(event).not.toBeNull();
    expect(event?.location).toBeUndefined();
    expect(event?.distanceMeters).toBe(20);
    expect(event?.outcome).toBe('ACCEPTED');
  });

  it('cancels queued delivery for an incident that was returned before the tick', async () => {
    const { incident } = await seedOutbox(ctx, organization, site, ownerId);
    await ctx.c.incidents.updateOne(
      { _id: incident._id },
      { $set: { state: 'RETURNED', returnedAt: new Date() } },
    );
    const mailBefore = (await readdir(join(notificationsDir, 'mail'))).length;

    const response = await tickAgent(ctx)
      .query({ max: 10 })
      .set('authorization', `Bearer ${SECRET}`);
    expect(response.status).toBe(200);

    const items = await ctx.c.outbox.find({ incidentId: incident._id }).toArray();
    expect(items.every((item) => item.state === 'CANCELLED')).toBe(true);
    expect((await readdir(join(notificationsDir, 'mail'))).length).toBe(mailBefore);
  });
});
