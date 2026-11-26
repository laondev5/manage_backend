import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrganizationDoc, SiteDoc } from '../../database/index.js';
import { createTestContext, insideLocation, type TestAgent, type TestContext } from './harness.js';

describe('attendance integrity', () => {
  let ctx: TestContext;
  let site: SiteDoc;
  let secondSite: SiteDoc;
  let organization: OrganizationDoc;
  let staffAgent: TestAgent;
  let staffId: string;

  const eventBody = (overrides: Record<string, unknown> = {}) => ({
    clientEventId: crypto.randomUUID(),
    clientShiftId: crypto.randomUUID(),
    deviceId: 'device-test-0001',
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
    ctx = await createTestContext();
    const owner = await ctx.createUser('owner@example.com', 'Owner');
    staffId = await ctx.createUser('staff@example.com', 'Staff');
    organization = await ctx.createOrganization('Northwind', 'owner@example.com');
    site = await ctx.createSite({
      organization,
      name: 'Marina Tower',
      ownerIds: [owner],
      createdBy: owner,
    });
    await ctx.createMembership({ organization, userId: owner, role: 'SITE_OWNER' });
    const membership = await ctx.createMembership({
      organization,
      userId: staffId,
      role: 'STAFF',
    });
    await ctx.assign({ organization, site, userId: staffId, membership });
    secondSite = await ctx.createSite({
      organization,
      name: 'Lagos Annex',
      ownerIds: [owner],
      createdBy: owner,
    });
    await ctx.assign({ organization, site: secondSite, userId: staffId, membership });
    staffAgent = await ctx.signIn('staff@example.com');
  });

  beforeEach(async () => {
    await ctx.c.attendanceEvents.deleteMany({});
    await ctx.c.incidents.deleteMany({});
    await ctx.c.shifts.deleteMany({});
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('accepts an inside clock-in and returns a duplicate for a replay', async () => {
    const body = eventBody();
    const first = await postEvent(body, 'idem-first');
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe('ACCEPTED');

    const replay = await postEvent(body, 'idem-replay');
    expect(replay.status).toBe(200);
    expect(replay.body.outcome).toBe('DUPLICATE');

    expect(await ctx.c.shifts.find({ userId: staffId }).toArray()).toHaveLength(1);
    expect(
      await ctx.c.attendanceEvents.countDocuments({ clientEventId: body.clientEventId }),
    ).toBe(1);
  });

  it('permits only one active shift per user under concurrent attempts', async () => {
    const attempts = await Promise.all([
      postEvent(eventBody(), 'race-a'),
      postEvent(eventBody(), 'race-b'),
    ]);
    const accepted = attempts.filter((response) => response.body.outcome === 'ACCEPTED');
    expect(accepted).toHaveLength(1);
    expect(await ctx.c.shifts.countDocuments({ userId: staffId, status: 'WORKING' })).toBe(1);
  });

  it('lets a staff member assigned to two sites clock in and out at either one', async () => {
    const atSecond = await postEvent(eventBody({ siteId: secondSite._id.toHexString() }), 'two-sites-in');
    expect(atSecond.body.outcome).toBe('ACCEPTED');
    let shift = await ctx.c.shifts.findOne({ userId: staffId, status: 'WORKING' });
    expect(shift?.siteId.toHexString()).toBe(secondSite._id.toHexString());

    const out = await postEvent({
      clientEventId: crypto.randomUUID(),
      clientShiftId: shift!.clientShiftId,
      deviceId: 'device-test-0001',
      siteId: secondSite._id.toHexString(),
      type: 'CLOCK_OUT',
      capturedAt: new Date().toISOString(),
      location: insideLocation(),
      sitePolicyVersion: 1,
    }, 'two-sites-out');
    expect(out.body.outcome).toBe('ACCEPTED');

    const atFirst = await postEvent(eventBody(), 'two-sites-back');
    expect(atFirst.body.outcome).toBe('ACCEPTED');
    shift = await ctx.c.shifts.findOne({ userId: staffId, status: 'WORKING' });
    expect(shift?.siteId.toHexString()).toBe(site._id.toHexString());
  });

  it('rejects a clock-in without location without creating a shift', async () => {
    const response = await postEvent(eventBody({ location: null }));
    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('REJECTED');
    const shift = await ctx.c.shifts.findOne({ userId: staffId });
    expect(shift).toBeNull();
  });

  it('clocks out the active shift and then allows a new clock-in', async () => {
    const first = await postEvent(eventBody());
    expect(first.body.outcome).toBe('ACCEPTED');
    const shift = await ctx.c.shifts.findOne({ status: 'WORKING' });
    expect(shift).toBeTruthy();

    const out = await postEvent({
      clientEventId: crypto.randomUUID(),
      clientShiftId: shift!.clientShiftId,
      deviceId: 'device-test-0001',
      siteId: shift!.siteId.toHexString(),
      type: 'CLOCK_OUT',
      capturedAt: new Date().toISOString(),
      location: insideLocation(),
      sitePolicyVersion: 1,
    });
    expect(out.body.outcome).toBe('ACCEPTED');

    const fresh = await postEvent(eventBody());
    expect(fresh.body.outcome).toBe('ACCEPTED');
    expect(await ctx.c.shifts.countDocuments({ userId: staffId, status: 'WORKING' })).toBe(1);
  });
});
