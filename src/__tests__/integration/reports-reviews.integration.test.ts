import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import type { MembershipDoc, OrganizationDoc, SiteDoc } from '../../database/index.js';
import {
  createTestContext,
  insideLocation,
  nativeHeaders,
  type TestAgent,
  type TestContext,
} from './harness.js';

const post = (agent: TestAgent, path: string, body?: object) =>
  agent.post(path).set(nativeHeaders).send(body);
const patch = (agent: TestAgent, path: string, body?: object) =>
  agent.patch(path).set(nativeHeaders).send(body);
const del = (agent: TestAgent, path: string) => agent.delete(path).set(nativeHeaders);

const eventBody = (site: SiteDoc, capturedAt = new Date().toISOString()) => ({
  clientEventId: crypto.randomUUID(),
  clientShiftId: crypto.randomUUID(),
  deviceId: 'device-test-0001',
  siteId: site._id.toHexString(),
  type: 'CLOCK_IN',
  capturedAt,
  location: insideLocation(),
  sitePolicyVersion: 1,
});

describe('staff reports, site reviews, and site roles', () => {
  let ctx: TestContext;
  let organization: OrganizationDoc;
  let site: SiteDoc;
  let ownerId: string;
  let staffAId: string;
  let staffBId: string;
  let staffCId: string;
  let staffAMembership: MembershipDoc;
  let ownerAgent: TestAgent;
  let staffAAgent: TestAgent;
  let staffBAgent: TestAgent;
  let staffCAgent: TestAgent;

  beforeAll(async () => {
    ctx = await createTestContext();
    ownerId = await ctx.createUser('roles-owner@example.com', 'Owning Owner');
    staffAId = await ctx.createUser('roles-staff-a@example.com', 'Staff Alpha');
    staffBId = await ctx.createUser('roles-staff-b@example.com', 'Staff Beta');
    staffCId = await ctx.createUser('roles-staff-c@example.com', 'Staff Gamma');
    organization = await ctx.createOrganization('Atlas Facilities', 'roles-owner@example.com');
    site = await ctx.createSite({
      organization,
      name: 'Marina Tower',
      ownerIds: [ownerId],
      createdBy: ownerId,
    });
    await ctx.createMembership({ organization, userId: ownerId, role: 'SITE_OWNER' });
    staffAMembership = await ctx.createMembership({
      organization,
      userId: staffAId,
      role: 'STAFF',
    });
    const membershipB = await ctx.createMembership({
      organization,
      userId: staffBId,
      role: 'STAFF',
    });
    await ctx.createMembership({ organization, userId: staffCId, role: 'STAFF' });
    await ctx.assign({ organization, site, userId: staffAId, membership: staffAMembership });
    await ctx.assign({ organization, site, userId: staffBId, membership: membershipB });
    ownerAgent = await ctx.signIn('roles-owner@example.com');
    staffAAgent = await ctx.signIn('roles-staff-a@example.com');
    staffBAgent = await ctx.signIn('roles-staff-b@example.com');
    staffCAgent = await ctx.signIn('roles-staff-c@example.com');
  });

  beforeEach(async () => {
    await Promise.all([
      ctx.c.reports.deleteMany({}),
      ctx.c.siteReviews.deleteMany({}),
      ctx.c.incidents.deleteMany({}),
      ctx.c.alerts.deleteMany({}),
      ctx.c.outbox.deleteMany({}),
      ctx.c.shifts.deleteMany({}),
      ctx.c.observations.deleteMany({}),
      ctx.c.attendanceEvents.deleteMany({}),
    ]);
    await ctx.c.sites.updateMany(
      { organizationId: organization._id },
      { $set: { inspectorId: null, teamLeadId: null } },
    );
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('lets staff create, read, update, and delete their own reports', async () => {
    const created = await post(staffAAgent, '/api/v1/reports', {
      title: 'Opening checklist',
      body: 'Checked the lobby doors and fire exits before the shift.',
    });
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe('GENERAL');
    expect(created.body.siteId).toBeNull();
    expect(created.body.authorId).toBe(staffAId);
    expect(created.body.version).toBe(1);
    const reportId = created.body.id as string;

    const mine = await staffAAgent.get('/api/v1/reports');
    expect(mine.status).toBe(200);
    expect(mine.body.some((entry: { id: string }) => entry.id === reportId)).toBe(true);

    expect((await staffAAgent.get(`/api/v1/reports/${reportId}`)).status).toBe(200);
    expect((await staffBAgent.get(`/api/v1/reports/${reportId}`)).status).toBe(404);
    expect((await staffBAgent.patch(`/api/v1/reports/${reportId}`).set(nativeHeaders).send({
      title: 'Hijacked',
      version: 1,
    })).status).toBe(404);

    const ownerRead = await ownerAgent.get(`/api/v1/reports/${reportId}`);
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.body.title).toBe('Opening checklist');
    const ownerEdit = await patch(ownerAgent, `/api/v1/reports/${reportId}`, {
      title: 'Owner override',
      version: 1,
    });
    expect(ownerEdit.status).toBe(404);

    const updated = await patch(staffAAgent, `/api/v1/reports/${reportId}`, {
      title: 'Opening checklist (revised)',
      version: 1,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe('Opening checklist (revised)');
    expect(updated.body.version).toBe(2);

    const stale = await patch(staffAAgent, `/api/v1/reports/${reportId}`, {
      body: 'A late edit against the first version.',
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_VERSION');

    const removed = await del(staffAAgent, `/api/v1/reports/${reportId}`);
    expect(removed.status).toBe(200);
    expect(removed.body.ok).toBe(true);
    expect((await staffAAgent.get(`/api/v1/reports/${reportId}`)).status).toBe(404);

    const afterDelete = await staffAAgent.get('/api/v1/reports');
    expect(afterDelete.body.some((entry: { id: string }) => entry.id === reportId)).toBe(false);

    const teamScope = await staffAAgent.get('/api/v1/reports?scope=team');
    expect(teamScope.status).toBe(403);
  });

  it('blocks clock-in until the staff member accepts the site assignment', async () => {
    const fresh = await ctx.createSite({
      organization,
      name: 'Riverside Depot',
      ownerIds: [ownerId],
      createdBy: ownerId,
    });
    await ctx.assign({
      organization,
      site: fresh,
      userId: staffAId,
      membership: staffAMembership,
      acceptedAt: null,
    });

    const sitesBefore = await staffAAgent.get('/api/v1/sites?scope=current');
    const entryBefore = sitesBefore.body.find(
      (item: { id: string }) => item.id === fresh._id.toHexString(),
    );
    expect(entryBefore.assignmentAcceptedAt).toBeNull();

    const blocked = await post(staffAAgent, '/api/v1/attendance/events', eventBody(fresh));
    expect(blocked.status).toBe(200);
    expect(blocked.body.outcome).toBe('REJECTED');
    expect(blocked.body.message).toContain('Accept this site assignment');
    expect(await ctx.c.shifts.countDocuments({ userId: staffAId, status: 'WORKING' })).toBe(0);

    const accepted = await post(
      staffAAgent,
      `/api/v1/sites/${fresh._id.toHexString()}/assignments/accept`,
    );
    expect(accepted.status).toBe(200);
    expect(typeof accepted.body.acceptedAt).toBe('string');

    const sitesAfter = await staffAAgent.get('/api/v1/sites?scope=current');
    const entryAfter = sitesAfter.body.find(
      (item: { id: string }) => item.id === fresh._id.toHexString(),
    );
    expect(typeof entryAfter.assignmentAcceptedAt).toBe('string');

    const clocked = await post(staffAAgent, '/api/v1/attendance/events', eventBody(fresh));
    expect(clocked.body.outcome).toBe('ACCEPTED');
  });

  it('records one review per member and keeps edits author-only', async () => {
    const created = await post(staffAAgent, `/api/v1/sites/${site._id.toHexString()}/reviews`, {
      rating: 4,
      comment: 'Clear signage and a tidy guard post.',
    });
    expect(created.status).toBe(201);
    expect(created.body.mine).toBe(true);
    expect(created.body.version).toBe(1);
    const reviewId = created.body.id as string;

    const duplicate = await post(staffAAgent, `/api/v1/sites/${site._id.toHexString()}/reviews`, {
      rating: 5,
      comment: 'A second review from the same member.',
    });
    expect(duplicate.status).toBe(409);

    const intruderEdit = await patch(
      staffBAgent,
      `/api/v1/sites/${site._id.toHexString()}/reviews/${reviewId}`,
      { rating: 5, version: 1 },
    );
    expect(intruderEdit.status).toBe(409);

    const intruderDelete = await del(
      staffBAgent,
      `/api/v1/sites/${site._id.toHexString()}/reviews/${reviewId}`,
    );
    expect(intruderDelete.status).toBe(404);

    const unassigned = await post(staffCAgent, `/api/v1/sites/${site._id.toHexString()}/reviews`, {
      rating: 3,
      comment: 'Not assigned here yet.',
    });
    expect(unassigned.status).toBe(404);

    const updated = await patch(
      staffAAgent,
      `/api/v1/sites/${site._id.toHexString()}/reviews/${reviewId}`,
      { rating: 5, comment: 'Even better after the morning briefing.', version: 1 },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.rating).toBe(5);
    expect(updated.body.version).toBe(2);

    const listed = await staffBAgent.get(`/api/v1/sites/${site._id.toHexString()}/reviews`);
    expect(listed.status).toBe(200);
    expect(listed.body.reviewCount).toBe(1);
    expect(listed.body.averageRating).toBe(5);
    expect(listed.body.mine).toBeNull();

    const removed = await del(
      staffAAgent,
      `/api/v1/sites/${site._id.toHexString()}/reviews/${reviewId}`,
    );
    expect(removed.status).toBe(200);
    const empty = await staffAAgent.get(`/api/v1/sites/${site._id.toHexString()}/reviews`);
    expect(empty.body.reviewCount).toBe(0);
    expect(empty.body.mine).toBeNull();
  });

  it('lets the owner choose a team lead from assigned staff', async () => {
    const siteId = site._id.toHexString();
    const setLead = await post(ownerAgent, `/api/v1/sites/${siteId}/team-lead`, {
      memberId: staffBId,
    });
    expect(setLead.status).toBe(200);
    expect(setLead.body.teamLeadId).toBe(staffBId);
    expect(setLead.body.teamLeadName).toBe('Staff Beta');

    const roster = await ownerAgent.get(`/api/v1/sites/${siteId}/roster`);
    const lead = roster.body.find((entry: { memberId: string }) => entry.memberId === staffBId);
    const other = roster.body.find((entry: { memberId: string }) => entry.memberId === staffAId);
    expect(lead.isTeamLead).toBe(true);
    expect(other.isTeamLead).toBe(false);

    const unassigned = await post(ownerAgent, `/api/v1/sites/${siteId}/team-lead`, {
      memberId: staffCId,
    });
    expect(unassigned.status).toBe(422);

    const staffAttempt = await post(staffAAgent, `/api/v1/sites/${siteId}/team-lead`, {
      memberId: staffAId,
    });
    expect(staffAttempt.status).toBe(403);

    const cleared = await post(ownerAgent, `/api/v1/sites/${siteId}/team-lead`, {
      memberId: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.teamLeadId).toBeNull();
  });

  it('lets the owner inspect personally or assign an inspector and marks inspection reports', async () => {
    const siteId = site._id.toHexString();

    const beforeInspection = await post(ownerAgent, '/api/v1/reports', {
      title: 'Untethered inspection',
      body: 'This should fail until the owner is the inspector.',
      siteId,
    });
    expect(beforeInspection.status).toBe(403);

    const self = await post(ownerAgent, `/api/v1/sites/${siteId}/inspector`, {
      inspectorId: ownerId,
    });
    expect(self.status).toBe(200);
    expect(self.body.inspectingSelf).toBe(true);
    expect(self.body.inspectorId).toBe(ownerId);

    const ownerReport = await post(ownerAgent, '/api/v1/reports', {
      title: 'Monthly safety walk',
      body: 'Checked extinguisher dates, lighting, and the loading bay.',
      siteId,
    });
    expect(ownerReport.status).toBe(201);
    expect(ownerReport.body.kind).toBe('INSPECTION');
    expect(ownerReport.body.siteName).toBe('Marina Tower');

    const staffCannotRead = await staffAAgent.get(`/api/v1/reports/${ownerReport.body.id}`);
    expect(staffCannotRead.status).toBe(404);

    const assigned = await post(ownerAgent, `/api/v1/sites/${siteId}/inspector`, {
      inspectorId: staffBId,
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.inspectingSelf).toBe(false);
    expect(assigned.body.inspectorName).toBe('Staff Beta');

    const inspectorReport = await post(staffBAgent, '/api/v1/reports', {
      title: 'Inspector walkthrough',
      body: 'Team lead briefed the guards on the new visitor process.',
      siteId,
    });
    expect(inspectorReport.status).toBe(201);
    expect(inspectorReport.body.kind).toBe('INSPECTION');

    const assigneeReport = await post(staffAAgent, '/api/v1/reports', {
      title: 'Shift handover note',
      body: 'Handed the night log to the incoming guard.',
      siteId,
    });
    expect(assigneeReport.status).toBe(201);
    expect(assigneeReport.body.kind).toBe('SITE');

    const teamReports = await ownerAgent.get('/api/v1/reports?scope=team');
    expect(teamReports.status).toBe(200);
    const inspectionKinds = teamReports.body
      .filter((entry: { id: string }) =>
        [ownerReport.body.id, inspectorReport.body.id].includes(entry.id),
      )
      .map((entry: { kind: string }) => entry.kind);
    expect(inspectionKinds).toEqual(['INSPECTION', 'INSPECTION']);

    const unassignedInspector = await post(ownerAgent, `/api/v1/sites/${siteId}/inspector`, {
      inspectorId: staffCId,
    });
    expect(unassignedInspector.status).toBe(422);

    const cleared = await post(ownerAgent, `/api/v1/sites/${siteId}/inspector`, {
      inspectorId: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.inspectorId).toBeNull();
    expect(cleared.body.inspectingSelf).toBe(false);
  });

  it('raises an owner alert when a working staff member leaves the site', async () => {
    const siteId = site._id.toHexString();
    const clockIn = await post(staffBAgent, '/api/v1/attendance/events', eventBody(site));
    expect(clockIn.body.outcome).toBe('ACCEPTED');

    const current = await staffBAgent.get('/api/v1/shifts/current');
    const shiftId = current.body.activeShift?.id as string;
    expect(shiftId).toBeTruthy();

    const outside = {
      ...insideLocation(1000),
      capturedAt: new Date().toISOString(),
    };
    const first = await post(staffBAgent, '/api/v1/location/observations', {
      clientObservationId: crypto.randomUUID(),
      shiftId,
      siteId,
      latitude: outside.latitude,
      longitude: outside.longitude,
      accuracyMeters: outside.accuracyMeters,
      capturedAt: outside.capturedAt,
    });
    expect(first.status).toBe(202);
    expect(first.body.presence).toBe('EXIT_PENDING');

    const candidate = await ctx.c.incidents.findOne({ shiftId: new ObjectId(shiftId) });
    expect(candidate?.state).toBe('CANDIDATE');
    expect(await ctx.c.alerts.countDocuments({ incidentId: candidate?._id })).toBe(0);

    const confirmAt = new Date(new Date(outside.capturedAt).getTime() + 121_000).toISOString();
    const second = await post(staffBAgent, '/api/v1/location/observations', {
      clientObservationId: crypto.randomUUID(),
      shiftId,
      siteId,
      latitude: outside.latitude,
      longitude: outside.longitude,
      accuracyMeters: outside.accuracyMeters,
      capturedAt: confirmAt,
    });
    expect(second.status).toBe(202);
    expect(second.body.presence).toBe('OUTSIDE');

    const incident = await ctx.c.incidents.findOne({ shiftId: new ObjectId(shiftId) });
    expect(incident?.state).toBe('CONFIRMED');
    expect(incident?.open).toBe(true);

    const alert = await ctx.c.alerts.findOne({ incidentId: incident?._id });
    expect(alert?.recipientId).toBe(ownerId);
    expect(alert?.channel).toBe('IN_APP');

    const queued = await ctx.c.outbox.find({ incidentId: incident?._id }).toArray();
    expect(queued).toHaveLength(2);
    expect(queued.every((row) => row.state === 'PENDING')).toBe(true);

    const ownerAlerts = await ownerAgent.get('/api/v1/alerts?state=UNREAD');
    expect(ownerAlerts.status).toBe(200);
    expect(
      ownerAlerts.body.items.some((item: { id: string }) => item.id === alert?._id.toHexString()),
    ).toBe(true);
  });
});
