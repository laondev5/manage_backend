import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  createTestContext,
  type TestAgent,
  type TestContext,
} from './harness.js';

describe('owner team member removal', () => {
  let ctx: TestContext;
  let owner: TestAgent;
  let staffAgent: TestAgent;
  let ownerId: string;
  let staffId: string;
  let organizationId: ObjectId;
  let siteId: ObjectId;
  let membershipId: ObjectId;

  const del = async (agent: TestAgent, path: string, body: object) => {
    const csrf = await agent.get('/api/v1/csrf').set('origin', 'http://localhost:3000');
    expect(csrf.status).toBe(200);
    return agent
      .delete(path)
      .set('origin', 'http://localhost:3000')
      .set('x-csrf-token', csrf.body.token)
      .send(body);
  };

  const workingShift = (userId: string) => ({
    _id: new ObjectId(),
    organizationId,
    siteId,
    userId,
    clientShiftId: `active-${userId}`,
    status: 'WORKING' as const,
    reviewState: 'ACCEPTED' as const,
    startedAt: new Date(),
    endedAt: null,
    startCapturedAt: new Date(),
    endCapturedAt: null,
    startEventId: null,
    endEventId: null,
    presence: {
      state: 'UNKNOWN' as const,
      candidateSince: null,
      lastQualifiedAt: null,
      lastAccuracyMeters: null,
      lastDistanceMeters: null,
      updatedAt: new Date(),
    },
    policyVersion: 1,
    siteTimezone: 'Africa/Lagos',
    reviewReason: null,
    staleFlaggedAt: null,
    lastSyncAt: new Date(),
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    ownerId = await ctx.createUser('removal-owner@example.com', 'Removal Owner');
    staffId = await ctx.createUser('removal-staff@example.com', 'Removal Staff');
    const organization = await ctx.createOrganization('Removal Org', 'removal-owner@example.com');
    organizationId = organization._id;
    const site = await ctx.createSite({
      organization,
      name: 'Removal Site',
      ownerIds: [ownerId],
      createdBy: ownerId,
    });
    siteId = site._id;
    await ctx.createMembership({ organization, userId: ownerId, role: 'SITE_OWNER' });
    const membership = await ctx.createMembership({ organization, userId: staffId, role: 'STAFF' });
    membershipId = membership._id;
    await ctx.assign({ organization, site, userId: staffId, membership });
    owner = await ctx.signIn('removal-owner@example.com');
    staffAgent = await ctx.signIn('removal-staff@example.com');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('denies staff removal attempts and owner self-removal', async () => {
    expect((await del(staffAgent, `/api/v1/team/${staffId}`, {
      reason: 'staff attempting removal',
      expectedVersion: 1,
    })).status).toBe(403);
    expect((await del(owner, `/api/v1/team/${ownerId}`, {
      reason: 'owner attempting removal',
      expectedVersion: 1,
    })).status).toBe(404);
  });

  it('removes a member from a site without revoking their organization membership', async () => {
    const assignment = await ctx.c.assignments.findOne({
      siteId,
      memberId: staffId,
      effectiveTo: null,
    });
    expect(assignment).toBeTruthy();
    const response = await del(
      owner,
      `/api/v1/sites/${siteId}/assignments/${assignment!._id.toHexString()}`,
      { reason: 'moved to another site' },
    );
    expect(response.status).toBe(200);
    expect(await ctx.c.memberships.countDocuments({ _id: membershipId, status: 'ACTIVE' })).toBe(1);
    expect(await ctx.c.assignments.countDocuments({ _id: assignment!._id, effectiveTo: null })).toBe(0);
    const audit = await ctx.c.auditEvents.findOne({
      action: 'assignment.ended',
      targetId: assignment!._id.toHexString(),
    });
    expect(audit?.meta.reason).toBe('moved to another site');

    // Restore the assignment for the team-removal checks below.
    const membership = await ctx.c.memberships.findOne({ _id: membershipId });
    const site = await ctx.c.sites.findOne({ _id: siteId });
    const organization = await ctx.c.organizations.findOne({ _id: organizationId });
    await ctx.assign({
      organization: organization!,
      site: site!,
      userId: staffId,
      membership: membership!,
    });
  });

  it('blocks team removal while the member is clocked in', async () => {
    await ctx.c.shifts.insertOne(workingShift(staffId));
    const response = await del(owner, `/api/v1/team/${staffId}`, {
      reason: 'offboarding while on shift',
      expectedVersion: 1,
    });
    expect(response.status).toBe(409);
    await ctx.c.shifts.deleteMany({ organizationId, userId: staffId });
  });

  it('rejects a stale membership version', async () => {
    const response = await del(owner, `/api/v1/team/${staffId}`, {
      reason: 'stale update attempt',
      expectedVersion: 999,
    });
    expect(response.status).toBe(409);
  });

  it('removes a member from the whole team and revokes their access', async () => {
    await ctx.c.sites.updateOne(
      { _id: siteId },
      { $set: { teamLeadId: staffId, inspectorId: staffId } },
    );
    await ctx.c.invitations.insertOne({
      _id: new ObjectId(),
      organizationId,
      siteId: null,
      email: 'removal-staff@example.com',
      role: 'STAFF',
      tokenHash: 'pending-removal-token',
      status: 'PENDING',
      note: null,
      createdBy: ownerId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      acceptedBy: null,
    });
    const detail = await owner.get(`/api/v1/team/${staffId}`);
    expect(detail.status).toBe(200);
    const version = detail.body.member.membershipVersion as number;

    const response = await del(owner, `/api/v1/team/${staffId}`, {
      reason: 'left the organization',
      expectedVersion: version,
    });
    expect(response.status).toBe(200);
    expect(response.body.membershipsRevoked).toBe(1);
    expect(response.body.assignmentsEnded).toBeGreaterThanOrEqual(1);
    expect(await ctx.c.memberships.countDocuments({ _id: membershipId, status: 'REVOKED' })).toBe(1);
    expect(await ctx.c.assignments.countDocuments({ siteId, memberId: staffId, effectiveTo: null })).toBe(0);
    expect(await ctx.c.invitations.countDocuments({ email: 'removal-staff@example.com', status: 'REVOKED' })).toBe(1);
    const site = await ctx.c.sites.findOne({ _id: siteId });
    expect(site?.teamLeadId).toBeNull();
    expect(site?.inspectorId).toBeNull();
    const audit = await ctx.c.auditEvents.findOne({
      action: 'member.removed',
      targetId: staffId,
    });
    expect(audit?.meta.reason).toBe('left the organization');
  });
});
