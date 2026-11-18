import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { sha256 } from '../../database/index.js';
import {
  createTestContext,
  type TestAgent,
  type TestContext,
} from './harness.js';

describe('admin organization and people management', () => {
  let ctx: TestContext;
  let admin: TestAgent;
  let ownerAgent: TestAgent;
  let adminUserId: string;
  let ownerId: string;
  let disposableOrgId: ObjectId;

  const mutate = async (agent: TestAgent, method: 'post' | 'delete', path: string, body: object) => {
    const csrf = await agent.get('/api/v1/csrf').set('origin', 'http://localhost:3000');
    expect(csrf.status).toBe(200);
    let call = agent[method](path).set('origin', 'http://localhost:3000').set('x-csrf-token', csrf.body.token);
    if (method === 'post') call = call.send(body);
    else call = call.send(body);
    return call;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    adminUserId = await ctx.createUser('mgmt-admin@example.com', 'Management Admin');
    ownerId = await ctx.createUser('mgmt-owner@example.com', 'Management Owner');
    await ctx.createUser('mgmt-staff@example.com', 'Management Staff');
    const org = await ctx.createOrganization('Management Org', 'mgmt-owner@example.com');
    const keep = await ctx.createOrganization('Keeper Org', 'mgmt-admin@example.com');
    disposableOrgId = org._id;
    await ctx.createMembership({ organization: org, userId: adminUserId, role: 'PLATFORM_ADMIN' });
    await ctx.createMembership({ organization: keep, userId: adminUserId, role: 'PLATFORM_ADMIN' });
    await ctx.createMembership({ organization: org, userId: ownerId, role: 'SITE_OWNER' });
    admin = await ctx.signIn('mgmt-admin@example.com');
    ownerAgent = await ctx.signIn('mgmt-owner@example.com');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('denies owner access to admin create/delete/invite endpoints', async () => {
    expect((await ownerAgent.get('/api/v1/admin/overview')).status).toBe(403);
    expect(
      (await mutate(ownerAgent, 'delete', `/api/v1/admin/organizations/${disposableOrgId}`, {
        version: 1,
        reason: 'owner attempt',
      })).status,
    ).toBe(403);
    expect(
      (await mutate(ownerAgent, 'post', '/api/v1/admin/admins', {
        email: 'new-admin@example.com',
        organizationId: disposableOrgId.toHexString(),
      })).status,
    ).toBe(403);
  });

  it('lets an admin invite a platform admin with a single-use role-bearing token', async () => {
    const response = await mutate(admin, 'post', '/api/v1/admin/admins', {
      email: 'new-admin@example.com',
      organizationId: disposableOrgId.toHexString(),
      note: 'coverage for admin creation',
    });
    expect(response.status).toBe(201);
    expect(response.body.role).toBe('PLATFORM_ADMIN');
    expect(response.body.developmentToken).toBeTruthy();
    const invitation = await ctx.c.invitations.findOne({
      tokenHash: sha256(response.body.developmentToken),
    });
    expect(invitation?.role).toBe('PLATFORM_ADMIN');
  });

  it('lets an admin invite a site owner, while owner invitations remain staff-only', async () => {
    const ownerInvite = await mutate(
      admin,
      'post',
      `/api/v1/admin/organizations/${disposableOrgId}/members`,
      { email: 'new-owner@example.com', role: 'SITE_OWNER' },
    );
    expect(ownerInvite.status).toBe(201);
    const invitation = await ctx.c.invitations.findOne({
      tokenHash: sha256(ownerInvite.body.developmentToken),
    });
    expect(invitation?.role).toBe('SITE_OWNER');

    const staffInvite = await mutate(
      ownerAgent,
      'post',
      '/api/v1/team/invitations',
      { email: 'owner-invited@example.com' },
    );
    expect(staffInvite.status).toBe(201);
    const staffInvitation = await ctx.c.invitations.findOne({
      tokenHash: sha256(staffInvite.body.developmentToken),
    });
    expect(staffInvitation?.role).toBe('STAFF');
  });

  it('refuses to delete an organization holding active shifts', async () => {
    const org = await ctx.c.organizations.findOne({ _id: disposableOrgId });
    expect(org).toBeTruthy();
    const site = await ctx.createSite({
      organization: org!,
      name: 'Active Shift Site',
      ownerIds: [ownerId],
      createdBy: adminUserId,
    });
    await ctx.c.shifts.insertOne({
      _id: new ObjectId(),
      organizationId: disposableOrgId,
      siteId: site._id,
      userId: 'mgmt-staff',
      clientShiftId: 'active-shift',
      status: 'WORKING',
      reviewState: 'ACCEPTED',
      startedAt: new Date(),
      endedAt: null,
      startCapturedAt: new Date(),
      endCapturedAt: null,
      startEventId: null,
      endEventId: null,
      presence: {
        state: 'UNKNOWN',
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
    const response = await mutate(admin, 'delete', `/api/v1/admin/organizations/${disposableOrgId}`, {
      version: org!.version,
      reason: 'active shift guard',
    });
    expect(response.status).toBe(409);
    await ctx.c.shifts.deleteMany({ organizationId: disposableOrgId });
  });

  it('soft-deletes an organization, revokes access and deactivates its only owner', async () => {
    const org = await ctx.c.organizations.findOne({ _id: disposableOrgId });
    const response = await mutate(admin, 'delete', `/api/v1/admin/organizations/${disposableOrgId}`, {
      version: org!.version,
      reason: 'organization no longer needed',
    });
    expect(response.status).toBe(200);
    expect(response.body.usersDeactivated).toBeGreaterThanOrEqual(1);
    expect(await ctx.c.organizations.countDocuments({ _id: disposableOrgId, deletedAt: null })).toBe(0);
    expect(await ctx.c.memberships.countDocuments({ organizationId: disposableOrgId, status: 'ACTIVE' })).toBe(0);
    expect(await ctx.c.assignments.countDocuments({ organizationId: disposableOrgId, effectiveTo: null })).toBe(0);
    expect(await ctx.c.sites.countDocuments({ organizationId: disposableOrgId, deletedAt: null })).toBe(0);
    const disabled = await ctx.c.users.findOne({ email: 'mgmt-owner@example.com' });
    expect(disabled?.status).toBe('DISABLED');
  });

  it('blocks a deactivated account from authenticated API access', async () => {
    const response = await ownerAgent.get('/api/v1/me');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('lets an admin reactivate a deactivated account', async () => {
    const response = await mutate(admin, 'post', `/api/v1/admin/users/${ownerId}/reactivate`, {
      reason: 'access restored after review',
    });
    expect(response.status).toBe(200);
    expect(await ctx.c.users.countDocuments({ _id: ownerId, status: 'DISABLED' })).toBe(0);
  });

  it('refuses to let an admin delete their own account', async () => {
    const response = await mutate(admin, 'delete', `/api/v1/admin/users/${adminUserId}`, {
      reason: 'self deletion attempt',
    });
    expect(response.status).toBe(409);
  });

  it('deletes a user and revokes access without erasing their identity', async () => {
    const email = 'delete-target@example.com';
    const targetId = await ctx.createUser(email, 'Delete Target');
    const organization = await ctx.createOrganization('Delete Target Org', email);
    const membership = await ctx.createMembership({
      organization,
      userId: targetId,
      role: 'STAFF',
    });
    const site = await ctx.createSite({
      organization,
      name: 'Delete Target Site',
      ownerIds: [targetId],
      createdBy: adminUserId,
    });
    await ctx.assign({ organization, site, userId: targetId, membership });
    await ctx.c.sites.updateOne(
      { _id: site._id },
      { $set: { teamLeadId: targetId, inspectorId: targetId } },
    );
    await ctx.c.invitations.insertOne({
      _id: new ObjectId(),
      organizationId: organization._id,
      siteId: null,
      email,
      role: 'STAFF',
      tokenHash: 'delete-target-token',
      status: 'PENDING',
      note: null,
      createdBy: adminUserId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
      acceptedBy: null,
    });
    const targetAgent = await ctx.signIn(email);

    const response = await mutate(admin, 'delete', `/api/v1/admin/users/${targetId}`, {
      reason: 'offboarded after review',
    });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('DELETED');
    expect(response.body.membershipsRevoked).toBeGreaterThanOrEqual(1);
    expect(response.body.assignmentsEnded).toBeGreaterThanOrEqual(1);
    expect(response.body.invitationsRevoked).toBe(1);
    expect(response.body.sitesCleared).toBe(1);

    const user = await ctx.c.users.findOne({ email });
    expect(user?.deletedAt).toBeTruthy();
    expect(await ctx.c.memberships.countDocuments({ userId: targetId, status: 'ACTIVE' })).toBe(0);
    expect(await ctx.c.assignments.countDocuments({ memberId: targetId, effectiveTo: null })).toBe(0);
    expect((await targetAgent.get('/api/v1/me')).status).toBe(403);
  });
});
