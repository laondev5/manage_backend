import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  createTestContext,
  type TestAgent,
  type TestContext,
} from './harness.js';

/**
 * Covers the explicit "delete from the database" behaviour: owners removing
 * staff permanently, and platform admins removing a site owner together with
 * the sites and staff under them.
 */
describe('permanent deletion cascades', () => {
  let ctx: TestContext;
  let owner: TestAgent;
  let admin: TestAgent;
  let ownerId: string;
  let adminId: string;
  let staffId: string;
  let secondStaffId: string;
  let organizationId: ObjectId;
  let siteId: ObjectId;
  let staffMembershipId: ObjectId;

  const del = async (agent: TestAgent, path: string, body: object) => {
    const csrf = await agent.get('/api/v1/csrf').set('origin', 'http://localhost:3000');
    expect(csrf.status).toBe(200);
    return agent
      .delete(path)
      .set('origin', 'http://localhost:3000')
      .set('x-csrf-token', csrf.body.token)
      .send(body);
  };

  // Better Auth stores user ids either as strings or as ObjectIds depending on
  // the adapter path, so every existence check must accept both shapes.
  const userIdFilter = (id: string) => ({
    $or: [{ _id: id }, ...(ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : [])],
  });
  const userExists = async (id: string) =>
    (await ctx.c.users.countDocuments(userIdFilter(id) as never)) > 0;

  beforeAll(async () => {
    ctx = await createTestContext();

    adminId = await ctx.createUser('purge-admin@example.com', 'Purge Admin');
    ownerId = await ctx.createUser('purge-owner@example.com', 'Purge Owner');
    staffId = await ctx.createUser('purge-staff@example.com', 'Purge Staff');
    secondStaffId = await ctx.createUser('purge-staff-two@example.com', 'Purge Staff Two');

    // A separate organization for the admin so removing the owner's account
    // cannot remove the administrator themselves.
    const adminOrg = await ctx.createOrganization('Purge Admin Org', 'purge-admin@example.com');
    const organization = await ctx.createOrganization('Purge Org', 'purge-owner@example.com');
    organizationId = organization._id;

    await ctx.createMembership({ organization: adminOrg, userId: adminId, role: 'PLATFORM_ADMIN' });
    await ctx.createMembership({ organization, userId: adminId, role: 'PLATFORM_ADMIN' });
    await ctx.createMembership({ organization, userId: ownerId, role: 'SITE_OWNER' });

    const staffMembership = await ctx.createMembership({
      organization,
      userId: staffId,
      role: 'STAFF',
    });
    staffMembershipId = staffMembership._id;
    await ctx.createMembership({ organization, userId: secondStaffId, role: 'STAFF' });

    const site = await ctx.createSite({
      organization,
      name: 'Purge Site',
      ownerIds: [ownerId],
      createdBy: ownerId,
    });
    siteId = site._id;
    await ctx.assign({ organization, site, userId: staffId, membership: staffMembership });

    owner = await ctx.signIn('purge-owner@example.com');
    admin = await ctx.signIn('purge-admin@example.com');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('permanently removes a staff member from the database', async () => {
    const detail = await owner.get(`/api/v1/team/${staffId}`);
    expect(detail.status).toBe(200);
    const version = detail.body.member.membershipVersion as number;

    // Give the staff member an auth account row and a device so the cascade
    // has more than the membership to clean up.
    await ctx.db.db.collection('account').insertOne({
      _id: new ObjectId(),
      userId: staffId,
      providerId: 'credential',
      accountId: staffId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    await ctx.c.devices.insertOne({
      _id: new ObjectId(),
      userId: staffId,
      deviceId: 'purge-device',
      platform: 'android',
      pushToken: 'token',
      pushEnabled: true,
      appVersion: '1.0.0',
      lastSeenAt: new Date(),
      createdAt: new Date(),
      revokedAt: null,
    });

    const response = await del(owner, `/api/v1/team/${staffId}`, {
      reason: 'permanent offboarding test',
      expectedVersion: version,
      permanent: true,
    });
    expect(response.status).toBe(200);
    expect(response.body.permanent).toBe(true);
    expect(response.body.purgedUserIds).toContain(staffId);

    // The person is genuinely gone, not merely disabled.
    expect(await userExists(staffId)).toBe(false);
    expect(await ctx.c.memberships.countDocuments({ _id: staffMembershipId })).toBe(0);
    expect(await ctx.c.assignments.countDocuments({ memberId: staffId })).toBe(0);
    expect(await ctx.c.devices.countDocuments({ userId: staffId })).toBe(0);
    expect(await ctx.db.db.collection('account').countDocuments({ userId: staffId })).toBe(0);
    expect(
      await ctx.c.auditEvents.countDocuments({ action: 'member.purged', targetId: staffId }),
    ).toBe(1);
  });

  it('permanently removes an owner, their sites, and that site’s staff', async () => {
    // Put a second staff member on the site so the cascade covers more than
    // one person.
    const secondMembership = await ctx.c.memberships.findOne({
      organizationId,
      userId: secondStaffId,
    });
    const site = await ctx.c.sites.findOne({ _id: siteId });
    const organization = await ctx.c.organizations.findOne({ _id: organizationId });
    expect(secondMembership).toBeTruthy();
    expect(site).toBeTruthy();
    expect(organization).toBeTruthy();
    await ctx.assign({
      organization: organization!,
      site: site!,
      userId: secondStaffId,
      membership: secondMembership!,
    });

    const response = await del(admin, `/api/v1/admin/users/${ownerId}`, {
      reason: 'permanent owner removal test',
      permanent: true,
    });
    expect(response.status).toBe(200);
    expect(response.body.permanent).toBe(true);
    expect(response.body.purgedUserIds).toContain(ownerId);
    expect(response.body.purgedUserIds).toContain(secondStaffId);
    expect(response.body.purgedSiteIds).toContain(siteId.toHexString());

    // Owner, their site, and the staff assigned to it all disappear.
    expect(await userExists(ownerId)).toBe(false);
    expect(await userExists(secondStaffId)).toBe(false);
    expect(await ctx.c.sites.countDocuments({ _id: siteId })).toBe(0);
    expect(await ctx.c.sitePolicies.countDocuments({ siteId })).toBe(0);
    expect(await ctx.c.assignments.countDocuments({ siteId })).toBe(0);
    expect(
      await ctx.c.auditEvents.countDocuments({ action: 'owner.purged', targetId: ownerId }),
    ).toBe(1);

    // The organization and admin remain — only the owner's tree was removed.
    expect(await ctx.c.organizations.countDocuments({ _id: organizationId })).toBe(1);
    expect(await userExists(adminId)).toBe(true);
  });
});
