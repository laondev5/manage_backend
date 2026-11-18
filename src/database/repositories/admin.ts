import { ObjectId } from 'mongodb';
import type {
  AccessGrantDoc,
  Collections,
  OrganizationDoc,
  SiteDoc,
} from '../collections.js';
import { updateSite, type UpdateSitePatch } from './sites.js';

export async function listOrganizations(c: Collections) {
  const organizations = await c.organizations.find({}).sort({ name: 1 }).toArray();
  if (!organizations.length) return [];
  const ids = organizations.map((org) => org._id);
  const [siteCounts, memberCounts, workingCounts] = await Promise.all([
    c.sites
      .aggregate<{ _id: ObjectId; count: number }>([
        { $match: { organizationId: { $in: ids } } },
        { $group: { _id: '$organizationId', count: { $sum: 1 } } },
      ])
      .toArray(),
    c.memberships
      .aggregate<{ _id: ObjectId; count: number }>([
        { $match: { organizationId: { $in: ids }, status: 'ACTIVE' } },
        { $group: { _id: '$organizationId', count: { $sum: 1 } } },
      ])
      .toArray(),
    c.shifts
      .aggregate<{ _id: ObjectId; count: number }>([
        { $match: { organizationId: { $in: ids }, status: 'WORKING' } },
        { $group: { _id: '$organizationId', count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);
  const siteMap = new Map(siteCounts.map((row) => [row._id.toHexString(), row.count]));
  const memberMap = new Map(memberCounts.map((row) => [row._id.toHexString(), row.count]));
  const workingMap = new Map(workingCounts.map((row) => [row._id.toHexString(), row.count]));
  return organizations.map((org) => ({
    organization: org,
    siteCount: siteMap.get(org._id.toHexString()) ?? 0,
    memberCount: memberMap.get(org._id.toHexString()) ?? 0,
    workingNow: workingMap.get(org._id.toHexString()) ?? 0,
  }));
}

export async function createOrganization(
  c: Collections,
  input: { name: string; contactEmail: string; timezone: string },
): Promise<OrganizationDoc> {
  const now = new Date();
  const doc: OrganizationDoc = {
    _id: new ObjectId(),
    name: input.name,
    status: 'ACTIVE',
    contactEmail: input.contactEmail,
    timezone: input.timezone,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await c.organizations.insertOne(doc);
  return doc;
}

export async function updateOrganization(
  c: Collections,
  organizationId: ObjectId,
  changes: Partial<Pick<OrganizationDoc, 'name' | 'status' | 'contactEmail'>>,
  expectedVersion: number,
): Promise<OrganizationDoc | null> {
  return c.organizations.findOneAndUpdate(
    { _id: organizationId, version: expectedVersion },
    { $set: { ...changes, updatedAt: new Date() }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
}

export async function listPlatformSites(c: Collections) {
  const sites = await c.sites.find({}).sort({ name: 1 }).limit(500).toArray();
  const orgIds = [...new Set(sites.map((site) => site.organizationId.toHexString()))];
  const organizations = orgIds.length
    ? await c.organizations.find({ _id: { $in: orgIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const orgById = new Map(organizations.map((org) => [org._id.toHexString(), org.name]));
  const staffCounts = await c.assignments
    .aggregate<{ _id: ObjectId; count: number }>([
      { $match: { siteId: { $in: sites.map((site) => site._id) }, effectiveTo: null } },
      { $group: { _id: '$siteId', count: { $sum: 1 } } },
    ])
    .toArray();
  const staffMap = new Map(staffCounts.map((row) => [row._id.toHexString(), row.count]));
  return sites.map((site) => ({
    site,
    organizationName: orgById.get(site.organizationId.toHexString()) ?? 'Unknown organization',
    staffCount: staffMap.get(site._id.toHexString()) ?? 0,
  }));
}

export async function updatePlatformSite(
  c: Collections,
  site: SiteDoc,
  patch: UpdateSitePatch,
  expectedVersion: number,
  actorId: string,
) {
  return updateSite(c, { site, expectedVersion, patch, actorId });
}

export async function listAuditEvents(
  c: Collections,
  input: {
    organizationId?: ObjectId;
    actorId?: string;
    action?: string;
    from?: Date;
    to?: Date;
    cursor?: string;
    limit: number;
  },
) {
  const filter: Record<string, unknown> = {};
  if (input.organizationId) filter.organizationId = input.organizationId;
  if (input.actorId) filter.actorId = input.actorId;
  if (input.action) filter.action = input.action;
  if (input.from || input.to) {
    filter.at = {
      ...(input.from ? { $gte: input.from } : {}),
      ...(input.to ? { $lte: input.to } : {}),
    };
  }
  if (input.cursor && ObjectId.isValid(input.cursor)) filter._id = { $lt: new ObjectId(input.cursor) };
  const docs = await c.auditEvents
    .find(filter)
    .sort({ _id: -1 })
    .limit(input.limit + 1)
    .toArray();
  const items = docs.slice(0, input.limit);
  return {
    items,
    nextCursor: docs.length > input.limit ? items.at(-1)?._id.toHexString() ?? null : null,
  };
}

export async function adminOverviewCounts(c: Collections) {
  const [organizations, activeSites, workingNow, openAlerts, pendingCorrections, outboxBacklog, failedDeliveries] =
    await Promise.all([
      c.organizations.countDocuments({ status: 'ACTIVE' }),
      c.sites.countDocuments({ status: 'ACTIVE' }),
      c.shifts.countDocuments({ status: 'WORKING' }),
      c.alerts.countDocuments({ state: { $ne: 'REVIEWED' } }),
      c.corrections.countDocuments({ status: 'PENDING' }),
      c.outbox.countDocuments({ state: { $in: ['PENDING', 'FAILED', 'LEASED'] } }),
      c.outbox.countDocuments({ state: 'DEAD' }),
    ]);
  return {
    organizations,
    activeSites,
    workingNow,
    openAlerts,
    pendingCorrections,
    outboxBacklog,
    failedDeliveries,
  };
}

export async function healthData(c: Collections) {
  const now = new Date();
  const [heartbeat, pending, leased, dead, oldest, resendConfigured] = await Promise.all([
    c.workerHeartbeats.findOne({ _id: 'worker' }),
    c.outbox.countDocuments({ state: { $in: ['PENDING', 'FAILED'] } }),
    c.outbox.countDocuments({ state: 'LEASED' }),
    c.outbox.countDocuments({ state: 'DEAD' }),
    c.outbox.find({ state: { $in: ['PENDING', 'FAILED'] } }).sort({ nextAttemptAt: 1 }).limit(1).toArray(),
    Promise.resolve(Boolean(process.env.RESEND_API_KEY)),
  ]);
  const last = heartbeat?.lastHeartbeatAt ?? null;
  const ageSeconds = last ? Math.round((now.getTime() - last.getTime()) / 1000) : null;
  const staleAfterSeconds = heartbeat?.staleAfterSeconds ?? 60;
  const mode = heartbeat?.mode ?? (heartbeat ? ('loop' as const) : ('unknown' as const));
  return {
    heartbeat,
    worker: {
      lastHeartbeatAt: last,
      ageSeconds,
      state:
        ageSeconds === null
          ? ('unknown' as const)
          : ageSeconds < staleAfterSeconds
            ? ('ok' as const)
            : ('stale' as const),
      mode,
      staleAfterSeconds,
    },
    outbox: {
      pending,
      leased,
      dead,
      oldestPendingAt: oldest[0]?.nextAttemptAt ?? null,
    },
    resendConfigured,
  };
}

export async function listAccessGrants(c: Collections) {
  const grants = await c.accessGrants.find({ revokedAt: null }).toArray();
  const adminIds = [...new Set(grants.map((grant) => grant.adminUserId))];
  const orgIds = [...new Set(grants.map((grant) => grant.organizationId.toHexString()))];
  const users = adminIds.length
    ? await c.users.find({ _id: { $in: adminIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const orgs = orgIds.length
    ? await c.organizations.find({ _id: { $in: orgIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const userById = new Map(users.map((user) => [user._id.toString(), user]));
  const orgById = new Map(orgs.map((org) => [org._id.toHexString(), org]));
  const siteIds = grants.filter((grant) => grant.siteId).map((grant) => grant.siteId as ObjectId);
  const sites = siteIds.length ? await c.sites.find({ _id: { $in: siteIds } }).toArray() : [];
  const siteById = new Map(sites.map((site) => [site._id.toHexString(), site.name]));
  return grants.map((grant) => ({
    grant,
    adminName: userById.get(grant.adminUserId)?.name ?? 'Unknown admin',
    organizationName: orgById.get(grant.organizationId.toHexString())?.name ?? 'Unknown organization',
    siteName: grant.siteId ? siteById.get(grant.siteId.toHexString()) ?? null : null,
  }));
}

export async function createAccessGrant(
  c: Collections,
  doc: AccessGrantDoc,
): Promise<AccessGrantDoc> {
  await c.accessGrants.insertOne(doc);
  return doc;
}

export async function revokeAccessGrant(c: Collections, grantId: ObjectId) {
  return c.accessGrants.updateOne(
    { _id: grantId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}
