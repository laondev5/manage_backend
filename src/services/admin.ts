import { ObjectId } from 'mongodb';
import {
  AppError,
  conflict,
  forbidden,
  notFound,
  sitePolicySchema,
  type AdminOverview,
  type AdminUserSummary,
  type AuditEvent,
  type Health,
  type OrganizationSummary,
  type PlatformSiteSummary,
  type TimesheetRow,
} from '../contracts/index.js';
import { canViewOperationalAttendance } from '../domain/index.js';
import {
  adminOverviewCounts,
  appendAudit,
  createAccessGrant,
  createOrganization,
  findSite,
  healthData,
  listAccessGrants,
  listAdminUsers,
  listAuditEvents,
  listOrganizations,
  listPlatformSites,
  listShiftsForSites,
  retryOutbox,
  revokeAccessGrant,
  updateMembership,
  updateOrganization,
  updatePlatformSite,
  usersByIds,
  type Database,
  type MembershipDoc,
  type OrganizationDoc,
  type OutboxDoc,
  type SiteDoc,
} from '../database/index.js';
import type { AuthContext } from '../http/context.js';
import type { Env } from '../env.js';
import { assertRange, exportRowsForSites, mapTimesheetRows } from './owner.js';

export function adminOrganizationIds(auth: AuthContext): string[] {
  return auth.actor.adminOrganizationIds;
}

function assertGranted(
  auth: AuthContext,
  capability: 'admin.attendance_read' | 'admin.exports' | 'admin.corrections_support' | 'admin.location_read',
  organizationId: string,
) {
  if (
    !auth.capabilities.includes(capability) ||
    !auth.actor.adminOrganizationIds.includes(organizationId)
  ) {
    throw forbidden('This operation requires an explicit, scoped administrative grant.');
  }
}

export async function overview(db: Database): Promise<AdminOverview> {
  const counts = await adminOverviewCounts(db.c);
  const stalePresence = await db.c.shifts.countDocuments({
    status: 'WORKING',
    'presence.state': 'UNKNOWN',
  });
  return { ...counts, stalePresence, generatedAt: new Date().toISOString() };
}

export async function organizations(db: Database): Promise<OrganizationSummary[]> {
  const rows = await listOrganizations(db.c);
  return rows.map((row) => ({
    id: row.organization._id.toHexString(),
    name: row.organization.name,
    status: row.organization.status,
    siteCount: row.siteCount,
    memberCount: row.memberCount,
    workingNow: row.workingNow,
    createdAt: row.organization.createdAt.toISOString(),
  }));
}

export async function createOrganizationAdmin(
  db: Database,
  auth: AuthContext,
  input: { name: string; contactEmail: string; timezone: string },
  requestId: string,
) {
  const org = await createOrganization(db.c, input);
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'organization.created',
    targetType: 'organization',
    targetId: org._id.toHexString(),
    organizationId: org._id,
    requestId,
    summary: `Created organization ${org.name}.`,
    meta: { timezone: org.timezone },
  });
  return {
    id: org._id.toHexString(),
    name: org.name,
    status: org.status,
    siteCount: 0,
    memberCount: 0,
    workingNow: 0,
    createdAt: org.createdAt.toISOString(),
  } satisfies OrganizationSummary;
}

export async function updateOrganizationAdmin(
  db: Database,
  auth: AuthContext,
  organizationId: ObjectId,
  input: { name?: string; status?: OrganizationDoc['status']; contactEmail?: string; version: number },
  requestId: string,
) {
  const { version, ...changes } = input;
  const updated = await updateOrganization(db.c, organizationId, changes, version);
  if (!updated) {
    throw conflict('This organization changed since you loaded it.', 'STALE_VERSION');
  }
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'organization.updated',
    targetType: 'organization',
    targetId: updated._id.toHexString(),
    organizationId: updated._id,
    requestId,
    summary: `Updated organization ${updated.name}.`,
    meta: { status: updated.status },
  });
  const rows = await listOrganizations(db.c);
  const row = rows.find((entry) => entry.organization._id.equals(updated._id));
  return {
    id: updated._id.toHexString(),
    name: updated.name,
    status: updated.status,
    siteCount: row?.siteCount ?? 0,
    memberCount: row?.memberCount ?? 0,
    workingNow: row?.workingNow ?? 0,
    createdAt: updated.createdAt.toISOString(),
  } satisfies OrganizationSummary;
}

export async function organizationDetail(db: Database, organizationId: ObjectId) {
  const org = await db.c.organizations.findOne({ _id: organizationId });
  if (!org) throw notFound('Organization not found.');
  const [sites, memberships] = await Promise.all([
    db.c.sites.find({ organizationId }).sort({ name: 1 }).toArray(),
    db.c.memberships.find({ organizationId, status: { $ne: 'REVOKED' } }).toArray(),
  ]);
  const users = await usersByIds(db.c, memberships.map((membership) => membership.userId));
  const shifts = await db.c.shifts.countDocuments({
    siteId: { $in: sites.map((site) => site._id) },
    status: 'WORKING',
  });
  return {
    id: org._id.toHexString(),
    name: org.name,
    status: org.status,
    contactEmail: org.contactEmail,
    timezone: org.timezone,
    version: org.version,
    createdAt: org.createdAt.toISOString(),
    workingNow: shifts,
    sites: sites.map((site) => ({
      id: site._id.toHexString(),
      name: site.name,
      status: site.status,
      radiusMeters: site.policy.radiusMeters,
      timezone: site.timezone,
      policyVersion: site.policyVersion,
    })),
    members: memberships.map((membership) => ({
      membershipId: membership._id.toHexString(),
      userId: membership.userId,
      name: users.get(membership.userId)?.name ?? 'Unknown member',
      email: users.get(membership.userId)?.email ?? '',
      role: membership.role,
      status: membership.status,
    })),
  };
}

export async function adminUsers(
  db: Database,
  input: { organizationId?: string } = {},
): Promise<AdminUserSummary[]> {
  const rows = await listAdminUsers(db.c);
  return rows
    .filter((row) =>
      input.organizationId
        ? row.memberships.some(
            (entry) => entry.membership.organizationId.toHexString() === input.organizationId,
          )
        : true,
    )
    .map((row) => ({
      id: row.userId,
      name: row.user.name,
      email: row.user.email,
      emailVerified: Boolean(row.user.emailVerified),
      twoFactorEnabled: Boolean(row.user.twoFactorEnabled),
      memberships: row.memberships.map((entry) => ({
        organizationId: entry.membership.organizationId.toHexString(),
        organizationName: entry.organization?.name ?? 'Unknown organization',
        role: entry.membership.role,
        status: entry.membership.status,
      })),
      lastSeenAt: null,
      createdAt: row.user.createdAt.toISOString(),
    }));
}

export async function updateMembershipAdmin(
  db: Database,
  auth: AuthContext,
  membershipId: ObjectId,
  input: { status?: MembershipDoc['status']; role?: 'STAFF' | 'SITE_OWNER'; reason: string },
  requestId: string,
) {
  const membership = await db.c.memberships.findOne({ _id: membershipId });
  if (!membership) throw notFound('Membership not found.');
  if (membership.role === 'PLATFORM_ADMIN' && input.status && input.status !== 'ACTIVE') {
    const activeAdmins = await db.c.memberships.countDocuments({
      role: 'PLATFORM_ADMIN',
      status: 'ACTIVE',
    });
    if (activeAdmins <= 1) {
      throw conflict('The last active platform administrator cannot be removed.', 'FORBIDDEN');
    }
  }
  const updated = await updateMembership(db.c, membershipId, {
    ...(input.status ? { status: input.status } : {}),
    ...(input.role ? { role: input.role } : {}),
  });
  if (!updated) throw notFound('Membership not found.');

  if (input.status && input.status !== 'ACTIVE') {
    await db.c.sites.updateMany(
      { organizationId: membership.organizationId, ownerIds: membership.userId },
      { $pull: { ownerIds: membership.userId } },
    );
  }

  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'membership.updated',
    targetType: 'membership',
    targetId: membershipId.toHexString(),
    organizationId: membership.organizationId,
    requestId,
    summary: `Updated access for a member: ${input.reason}`,
    meta: {
      status: input.status ?? membership.status,
      role: input.role ?? membership.role,
      reason: input.reason,
    },
  });
  return {
    id: updated._id.toHexString(),
    userId: updated.userId,
    organizationId: updated.organizationId.toHexString(),
    role: updated.role,
    status: updated.status,
  };
}

export async function platformSites(db: Database): Promise<PlatformSiteSummary[]> {
  const rows = await listPlatformSites(db.c);
  return rows.map((row) => ({
    id: row.site._id.toHexString(),
    name: row.site.name,
    organizationId: row.site.organizationId.toHexString(),
    organizationName: row.organizationName,
    radiusMeters: row.site.policy.radiusMeters,
    timezone: row.site.timezone,
    status: row.site.status,
    policyVersion: row.site.policyVersion,
    version: row.site.version,
    staffCount: row.staffCount,
  }));
}

export async function updateSiteAdmin(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  input: {
    name?: string;
    status?: SiteDoc['status'];
    radiusMeters?: number;
    timezone?: string;
    version: number;
    reason: string;
  },
  requestId: string,
) {
  const site = await findSite(db.c, siteId);
  if (!site) throw notFound('Site not found.');
  const policy = input.radiusMeters
    ? sitePolicySchema.parse({ ...site.policy, radiusMeters: input.radiusMeters })
    : undefined;
  const updated = await updatePlatformSite(
    db.c,
    site,
    {
      ...(input.name ? { name: input.name } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
      ...(policy ? { policy } : {}),
    },
    input.version,
    auth.user.id,
  );
  if (!updated) throw conflict('This site changed since you loaded it.', 'STALE_VERSION');
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: policy ? 'site.policy_updated' : 'site.updated',
    targetType: 'site',
    targetId: updated._id.toHexString(),
    organizationId: updated.organizationId,
    siteId: updated._id,
    requestId,
    summary: `Administrative site update: ${input.reason}`,
    meta: { policyVersion: updated.policyVersion, reason: input.reason },
  });
  return {
    id: updated._id.toHexString(),
    name: updated.name,
    organizationId: updated.organizationId.toHexString(),
    organizationName: '',
    radiusMeters: updated.policy.radiusMeters,
    timezone: updated.timezone,
    status: updated.status,
    policyVersion: updated.policyVersion,
    version: updated.version,
    staffCount: 0,
  } satisfies PlatformSiteSummary;
}

export async function auditEvents(
  db: Database,
  input: { organizationId?: string; action?: string; actorId?: string; from?: Date; to?: Date; cursor?: string; limit: number },
) {
  const result = await listAuditEvents(db.c, {
    organizationId: input.organizationId ? new ObjectId(input.organizationId) : undefined,
    actorId: input.actorId,
    action: input.action,
    from: input.from,
    to: input.to,
    cursor: input.cursor,
    limit: input.limit,
  });
  const items: AuditEvent[] = result.items.map((entry) => ({
    id: entry._id.toHexString(),
    at: entry.at.toISOString(),
    actorId: entry.actorId,
    actorName: entry.actorName,
    actorRole: entry.actorRole,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    organizationId: entry.organizationId?.toHexString() ?? null,
    siteId: entry.siteId?.toHexString() ?? null,
    requestId: entry.requestId,
    summary: entry.summary,
    hash: entry.hash,
    previousHash: entry.previousHash,
  }));
  return { items, nextCursor: result.nextCursor };
}

export async function health(db: Database, env: Env): Promise<Health> {
  const data = await healthData(db.c);
  const status =
    data.worker.state === 'ok' && data.outbox.dead === 0
      ? 'ok'
      : data.worker.state === 'stale'
        ? 'degraded'
        : 'degraded';
  return {
    status,
    database: 'ok',
    worker: {
      lastHeartbeatAt: data.worker.lastHeartbeatAt?.toISOString() ?? null,
      ageSeconds: data.worker.ageSeconds,
      state: data.worker.state,
      mode: data.worker.mode,
      staleAfterSeconds: data.worker.staleAfterSeconds,
    },
    outbox: {
      pending: data.outbox.pending,
      leased: data.outbox.leased,
      dead: data.outbox.dead,
      oldestPendingAt: data.outbox.oldestPendingAt?.toISOString() ?? null,
    },
    push: { provider: env.pushProvider, configured: env.pushProvider === 'expo' },
    email: { provider: env.emailProvider, configured: env.emailProvider === 'resend' },
    checkedAt: new Date().toISOString(),
  };
}

export async function grants(db: Database) {
  const rows = await listAccessGrants(db.c);
  return rows.map((row) => ({
    id: row.grant._id.toHexString(),
    adminUserId: row.grant.adminUserId,
    adminName: row.adminName,
    organizationId: row.grant.organizationId.toHexString(),
    organizationName: row.organizationName,
    siteId: row.grant.siteId?.toHexString() ?? null,
    siteName: row.siteName,
    capability: row.grant.capability,
    expiresAt: row.grant.expiresAt.toISOString(),
    createdAt: row.grant.createdAt.toISOString(),
  }));
}

export async function createGrant(
  db: Database,
  auth: AuthContext,
  input: {
    adminUserId: string;
    organizationId: string;
    siteId?: string | null;
    capability: 'admin.attendance_read' | 'admin.location_read' | 'admin.corrections_support' | 'admin.exports';
    expiresAt: string;
    reason: string;
  },
  requestId: string,
) {
  const membership = await db.c.memberships.findOne({
    userId: input.adminUserId,
    role: 'PLATFORM_ADMIN',
    status: 'ACTIVE',
  });
  if (!membership) throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active platform administrator.');
  const orgId = new ObjectId(input.organizationId);
  const org = await db.c.organizations.findOne({ _id: orgId });
  if (!org) throw notFound('Organization not found.');
  if (input.siteId) {
    const site = await findSite(db.c, new ObjectId(input.siteId));
    if (!site || !site.organizationId.equals(orgId)) {
      throw new AppError(422, 'VALIDATION_ERROR', 'The site must belong to the organization.');
    }
  }
  const expiresAt = new Date(input.expiresAt);
  const maxExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
  if (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > maxExpiry) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Grants must expire within the next 30 days.');
  }
  const grant = await createAccessGrant(db.c, {
    _id: new ObjectId(),
    adminUserId: input.adminUserId,
    organizationId: orgId,
    siteId: input.siteId ? new ObjectId(input.siteId) : null,
    capability: input.capability,
    expiresAt,
    reason: input.reason,
    createdBy: auth.user.id,
    createdAt: new Date(),
    revokedAt: null,
  });
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'grant.created',
    targetType: 'access_grant',
    targetId: grant._id.toHexString(),
    organizationId: orgId,
    siteId: grant.siteId,
    requestId,
    summary: `Granted ${input.capability} for ${org.name}.`,
    meta: { adminUserId: input.adminUserId, expiresAt: expiresAt.toISOString(), reason: input.reason },
  });
  return {
    id: grant._id.toHexString(),
    capability: grant.capability,
    expiresAt: grant.expiresAt.toISOString(),
  };
}

export async function revokeGrant(
  db: Database,
  auth: AuthContext,
  grantId: ObjectId,
  requestId: string,
) {
  const grant = await db.c.accessGrants.findOne({ _id: grantId });
  if (!grant) throw notFound('Grant not found.');
  const result = await revokeAccessGrant(db.c, grantId);
  if (!result.modifiedCount) throw notFound('Grant not found.');
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'grant.revoked',
    targetType: 'access_grant',
    targetId: grantId.toHexString(),
    organizationId: grant.organizationId,
    siteId: grant.siteId,
    requestId,
    summary: `Revoked ${grant.capability}.`,
    meta: { adminUserId: grant.adminUserId },
  });
  return { ok: true as const };
}

export async function retryDeliveries(
  db: Database,
  auth: AuthContext,
  outboxIds: string[],
  requestId: string,
) {
  const ids = outboxIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  if (!ids.length) throw new AppError(422, 'VALIDATION_ERROR', 'Choose at least one delivery.');
  const count = await retryOutbox(db.c, ids, auth.user.id);
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'delivery.retried',
    targetType: 'outbox',
    targetId: ids[0]?.toHexString() ?? null,
    requestId,
    summary: `Requeued ${count} notifications.`,
    meta: { count },
  });
  return { ok: true as const, retried: count };
}

export async function deliveries(
  db: Database,
  input: { state?: OutboxDoc['state']; cursor?: string; limit: number },
) {
  const filter: Record<string, unknown> = {};
  if (input.state) filter.state = input.state;
  if (input.cursor && ObjectId.isValid(input.cursor)) filter._id = { $lt: new ObjectId(input.cursor) };
  const docs = await db.c.outbox
    .find(filter)
    .sort({ _id: -1 })
    .limit(input.limit + 1)
    .toArray();
  const items = docs.slice(0, input.limit);
  return {
    items: items.map((doc) => ({
      id: doc._id.toHexString(),
      recipientId: doc.recipientId,
      channel: doc.channel,
      state: doc.state,
      attempts: doc.attempts,
      nextAttemptAt: doc.nextAttemptAt.toISOString(),
      lastError: doc.lastError,
      createdAt: doc.createdAt.toISOString(),
    })),
    nextCursor: docs.length > input.limit ? items.at(-1)?._id.toHexString() ?? null : null,
  };
}

function orgSiteIds(db: Database, organizationId: ObjectId, siteId?: string) {
  return (async () => {
    if (siteId) {
      const site = await findSite(db.c, new ObjectId(siteId));
      if (!site || !site.organizationId.equals(organizationId)) throw notFound('Site not found.');
      return [site._id];
    }
    const sites = await db.c.sites.find({ organizationId }).project({ _id: 1 }).toArray();
    return sites.map((site) => site._id);
  })();
}

export async function adminTimesheets(
  db: Database,
  auth: AuthContext,
  input: { organizationId: string; siteId?: string; from: Date; to: Date; cursor?: string; limit: number },
): Promise<{ items: TimesheetRow[]; nextCursor: string | null }> {
  assertGranted(auth, 'admin.attendance_read', input.organizationId);
  assertRange(input.from, input.to);
  const orgId = new ObjectId(input.organizationId);
  const siteIds = await orgSiteIds(db, orgId, input.siteId);
  const result = await listShiftsForSites(db.c, siteIds, {
    from: input.from,
    to: input.to,
    cursor: input.cursor,
    limit: input.limit,
  });
  const sites = await db.c.sites
    .find({ _id: { $in: [...new Set(result.items.map((shift) => shift.siteId))] } })
    .toArray();
  return { items: await mapTimesheetRows(db, result.items, sites), nextCursor: result.nextCursor };
}

export async function adminExport(
  db: Database,
  auth: AuthContext,
  input: { organizationId: string; siteId?: string; from: Date; to: Date },
  requestId: string,
) {
  assertGranted(auth, 'admin.exports', input.organizationId);
  const orgId = new ObjectId(input.organizationId);
  const siteIds = await orgSiteIds(db, orgId, input.siteId);
  return exportRowsForSites(db, auth, siteIds, orgId, input.from, input.to, requestId);
}

export function assertOperationalAccess(auth: AuthContext, organizationId: string) {
  if (!canViewOperationalAttendance(auth.actor, organizationId)) {
    throw forbidden('Operational attendance access requires an explicit administrative grant.');
  }
}
