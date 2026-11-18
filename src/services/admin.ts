import { ObjectId } from 'mongodb';
import { randomBytes } from 'node:crypto';
import {
  AppError,
  conflict,
  forbidden,
  notFound,
  sitePolicySchema,
  type AdminOverview,
  type AdminUserDeleteSummary,
  type AdminUserSummary,
  type AuditEvent,
  type Health,
  type OrganizationSummary,
  type PlatformSiteSummary,
  type TimesheetRow,
} from '../contracts/index.js';
import { canViewOperationalAttendance } from '../domain/index.js';
import { teamInvitationEmail } from '../mail.js';
import {
  adminOverviewCounts,
  appendAudit,
  createAccessGrant,
  createInvitation,
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
  sha256,
  updateMembership,
  updateOrganization,
  updatePlatformSite,
  usersByIds,
  withTransaction,
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

function userFilter(userId: string): { $or: Array<{ _id: string | ObjectId }> } {
  return {
    $or: [
      { _id: userId },
      ...(ObjectId.isValid(userId) ? [{ _id: new ObjectId(userId) }] : []),
    ],
  };
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
      accountStatus: row.user.deletedAt
        ? 'DELETED'
        : row.user.status === 'DISABLED'
          ? 'DISABLED'
          : 'ACTIVE',
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

/**
 * Soft-delete an organization and remove all operational access into it.
 * Attendance events, shifts, and audit history are deliberately retained so
 * payroll history stays append-only and attributable. Users whose only
 * organization was this one are disabled at the account level.
 */
export async function deleteOrganizationAdmin(
  db: Database,
  auth: AuthContext,
  organizationId: ObjectId,
  input: { version: number; reason: string },
  requestId: string,
) {
  const org = await db.c.organizations.findOne({ _id: organizationId, deletedAt: null });
  if (!org) throw notFound('Organization not found.');
  if (org.version !== input.version) {
    throw conflict('This organization changed since you loaded it.', 'STALE_VERSION');
  }
  if (org.status === 'ARCHIVED') {
    throw conflict('This organization is already archived.', 'CONFLICT');
  }
  const siteIds = (
    await db.c.sites.find({ organizationId, deletedAt: null }, { projection: { _id: 1 } }).toArray()
  ).map((site) => site._id);
  const workingShifts = siteIds.length
    ? await db.c.shifts.countDocuments({ siteId: { $in: siteIds }, status: 'WORKING' })
    : 0;
  if (workingShifts > 0) {
    throw conflict(
      'People are still clocked in at this organization. End those shifts before deleting it.',
      'CONFLICT',
    );
  }
  const activeAdmins = await db.c.memberships.countDocuments({
    role: 'PLATFORM_ADMIN',
    status: 'ACTIVE',
    organizationId: { $ne: organizationId },
  });
  const adminsHere = await db.c.memberships.countDocuments({
    role: 'PLATFORM_ADMIN',
    status: 'ACTIVE',
    organizationId,
  });
  if (adminsHere > 0 && activeAdmins === 0) {
    throw conflict(
      'This organization holds the last active platform administrator. Add another administrator first.',
      'CONFLICT',
    );
  }

  const memberships = await db.c.memberships
    .find({ organizationId, status: { $ne: 'REVOKED' } })
    .toArray();
  const memberIds = [...new Set(memberships.map((membership) => membership.userId))];
  const otherMemberships = memberIds.length
    ? await db.c.memberships
        .find({
          userId: { $in: memberIds },
          organizationId: { $ne: organizationId },
          status: 'ACTIVE',
        })
        .toArray()
    : [];
  const stillMember = new Set(otherMemberships.map((membership) => membership.userId));
  const toDeactivate = memberIds.filter((userId) => !stillMember.has(userId));
  const now = new Date();

  const counts: {
    membershipsRevoked: number;
    assignmentsEnded: number;
    sitesArchived: number;
    invitationsRevoked: number;
    grantsRevoked: number;
  } = {
    membershipsRevoked: 0,
    assignmentsEnded: 0,
    sitesArchived: 0,
    invitationsRevoked: 0,
    grantsRevoked: 0,
  };
  await withTransaction(db, async (session) => {
    const locked = await db.c.organizations.updateOne(
      { _id: organizationId, version: input.version, deletedAt: null },
      {
        $set: {
          status: 'ARCHIVED',
          deletedAt: now,
          deletedBy: auth.user.id,
          deletionReason: input.reason,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { session },
    );
    if (locked.modifiedCount !== 1) throw conflict('This organization changed while deleting it.', 'STALE_VERSION');

    counts.membershipsRevoked = (
      await db.c.memberships.updateMany(
        { organizationId, status: { $ne: 'REVOKED' } },
        { $set: { status: 'REVOKED', updatedAt: now }, $inc: { version: 1 } },
        { session },
      )
    ).modifiedCount;
    counts.assignmentsEnded = (
      await db.c.assignments.updateMany(
        { organizationId, effectiveTo: null },
        { $set: { effectiveTo: now, endedBy: auth.user.id } },
        { session },
      )
    ).modifiedCount;
    counts.sitesArchived = (
      await db.c.sites.updateMany(
        { organizationId, deletedAt: null },
        { $set: { deletedAt: now, status: 'INACTIVE', updatedAt: now }, $inc: { version: 1 } },
        { session },
      )
    ).modifiedCount;
    counts.invitationsRevoked = (
      await db.c.invitations.updateMany(
        { organizationId, status: 'PENDING' },
        { $set: { status: 'REVOKED' } },
        { session },
      )
    ).modifiedCount;
    counts.grantsRevoked = (
      await db.c.accessGrants.updateMany(
        { organizationId, revokedAt: null },
        { $set: { revokedAt: now } },
        { session },
      )
    ).modifiedCount;
    if (toDeactivate.length) {
      const userIds: Array<string | ObjectId> = [];
      for (const userId of toDeactivate) {
        userIds.push(userId);
        if (ObjectId.isValid(userId)) userIds.push(new ObjectId(userId));
      }
      await db.c.users.updateMany(
        { _id: { $in: userIds }, status: { $ne: 'DISABLED' } },
        {
          $set: {
            status: 'DISABLED',
            disabledAt: now,
            disabledReason: `Organization ${org.name} was deleted.`,
            updatedAt: now,
          },
        },
        { session },
      );
    }
  });

  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'organization.deleted',
    targetType: 'organization',
    targetId: organizationId.toHexString(),
    organizationId,
    requestId,
    summary: `Deleted organization ${org.name}. Attendance history was retained.`,
    meta: { reason: input.reason, ...counts, usersDeactivated: toDeactivate.length },
  });
  return {
    id: organizationId.toHexString(),
    name: org.name,
    ...counts,
    usersDeactivated: toDeactivate.length,
  };
}

export async function reactivateUserAdmin(
  db: Database,
  auth: AuthContext,
  userId: string,
  input: { reason: string },
  requestId: string,
) {
  const filter = userFilter(userId);
  const user = await db.c.users.findOne({ ...filter, status: 'DISABLED', deletedAt: null });
  if (!user) throw notFound('Deactivated account not found.');
  await db.c.users.updateOne(
    { ...filter, status: 'DISABLED', deletedAt: null },
    { $set: { status: 'ACTIVE', disabledAt: null, disabledReason: null, updatedAt: new Date() } },
  );
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'account.reactivated',
    targetType: 'user',
    targetId: userId,
    requestId,
    summary: `Reactivated ${user.email}.`,
    meta: { reason: input.reason },
  });
  return { id: userId, email: user.email, status: 'ACTIVE' as const };
}

/**
 * Platform-admin account deletion is a revocation, not a hard delete. The
 * identity document stays so append-only attendance, reports, and audit
 * entries remain attributable. Access, sessions, assignments, and pending
 * invitations are removed immediately.
 */
export async function deleteUserAdmin(
  db: Database,
  auth: AuthContext,
  userId: string,
  input: { reason: string },
  requestId: string,
): Promise<AdminUserDeleteSummary> {
  if (auth.user.id === userId) {
    throw conflict('You cannot delete your own account.', 'FORBIDDEN');
  }
  const filter = userFilter(userId);
  const user = await db.c.users.findOne({ ...filter, deletedAt: null });
  if (!user) throw notFound('Account not found.');

  const adminMembership = await db.c.memberships.findOne({
    userId,
    role: 'PLATFORM_ADMIN',
    status: 'ACTIVE',
  });
  if (adminMembership) {
    const otherAdmins = await db.c.memberships.countDocuments({
      role: 'PLATFORM_ADMIN',
      status: 'ACTIVE',
      userId: { $ne: userId },
    });
    if (otherAdmins === 0) {
      throw conflict('The last active platform administrator cannot be deleted.', 'FORBIDDEN');
    }
  }
  const workingShifts = await db.c.shifts.countDocuments({ userId, status: 'WORKING' });
  if (workingShifts > 0) {
    throw conflict(
      'This person is still clocked in. End their shift before deleting the account.',
      'CONFLICT',
    );
  }

  const now = new Date();
  const counts: {
    membershipsRevoked: number;
    assignmentsEnded: number;
    invitationsRevoked: number;
    grantsRevoked: number;
    sitesCleared: number;
    devicesRevoked: number;
    sessionsRevoked: number;
  } = {
    membershipsRevoked: 0,
    assignmentsEnded: 0,
    invitationsRevoked: 0,
    grantsRevoked: 0,
    sitesCleared: 0,
    devicesRevoked: 0,
    sessionsRevoked: 0,
  };

  await withTransaction(db, async (session) => {
    counts.membershipsRevoked = (
      await db.c.memberships.updateMany(
        { userId, status: { $ne: 'REVOKED' } },
        { $set: { status: 'REVOKED', updatedAt: now }, $inc: { version: 1 } },
        { session },
      )
    ).modifiedCount;
    counts.assignmentsEnded = (
      await db.c.assignments.updateMany(
        { memberId: userId, effectiveTo: null },
        { $set: { effectiveTo: now, endedBy: auth.user.id } },
        { session },
      )
    ).modifiedCount;
    counts.sitesCleared = (
      await db.c.sites.updateMany(
        { $or: [{ teamLeadId: userId }, { inspectorId: userId }] },
        { $set: { teamLeadId: null, inspectorId: null, updatedAt: now } },
        { session },
      )
    ).modifiedCount;
    counts.invitationsRevoked = (
      await db.c.invitations.updateMany(
        { email: user.email, status: 'PENDING' },
        { $set: { status: 'REVOKED' } },
        { session },
      )
    ).modifiedCount;
    counts.grantsRevoked = (
      await db.c.accessGrants.updateMany(
        { adminUserId: userId, revokedAt: null },
        { $set: { revokedAt: now } },
        { session },
      )
    ).modifiedCount;
    counts.devicesRevoked = (
      await db.c.devices.updateMany(
        { userId, revokedAt: null },
        { $set: { revokedAt: now, pushEnabled: false, pushToken: null } },
        { session },
      )
    ).modifiedCount;
    counts.sessionsRevoked = (
      await db.db.collection('session').deleteMany({ userId }, { session })
    ).deletedCount;
    const updated = await db.c.users.updateOne(
      { ...filter, deletedAt: null },
      {
        $set: {
          status: 'DISABLED',
          disabledAt: now,
          disabledReason: `Account deleted by ${auth.user.name}.`,
          deletedAt: now,
          deletedBy: auth.user.id,
          deletedReason: input.reason,
          updatedAt: now,
        },
      },
      { session },
    );
    if (updated.modifiedCount !== 1) {
      throw conflict('This account changed while it was being deleted.', 'STALE_VERSION');
    }
  });

  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'user.deleted',
    targetType: 'user',
    targetId: userId,
    organizationId: adminMembership?.organizationId ?? null,
    siteId: null,
    requestId,
    summary: `Deleted ${user.email}. Attendance and audit history were retained.`,
    meta: { reason: input.reason, ...counts },
  });
  return { id: userId, email: user.email, status: 'DELETED' as const, ...counts };
}

type AdminInviteDeps = {
  requestId: string;
  webUrl: string;
  allowDevToken: boolean;
  sendMail: (message: {
    to: string;
    subject: string;
    text: string;
    html: string;
    idempotencyKey: string;
  }) => Promise<unknown>;
  inviterName: string;
};

async function issueAdminInvitation(
  db: Database,
  auth: AuthContext,
  input: {
    email: string;
    organizationId: ObjectId;
    role: 'STAFF' | 'SITE_OWNER' | 'PLATFORM_ADMIN';
    siteId?: ObjectId | null;
    note?: string;
  },
  context: AdminInviteDeps,
  requestId: string,
) {
  const email = input.email.trim().toLowerCase();
  const existing = await db.c.users.findOne({ email });
  if (existing) {
    throw conflict('An account already exists for this email. Add them to the organization instead.');
  }
  const pending = await db.c.invitations.findOne({ email, status: 'PENDING' });
  if (pending) throw conflict('A pending invitation already exists for this email.');
  const org = await db.c.organizations.findOne({ _id: input.organizationId, deletedAt: null });
  if (!org) throw notFound('Organization not found.');
  if (input.siteId) {
    const site = await findSite(db.c, input.siteId);
    if (!site || !site.organizationId.equals(input.organizationId) || site.deletedAt) {
      throw new AppError(422, 'VALIDATION_ERROR', 'The site must belong to the organization.');
    }
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const invitation = await createInvitation(db.c, {
    organizationId: input.organizationId,
    siteId: input.siteId ?? null,
    email,
    role: input.role,
    tokenHash: sha256(token),
    note: input.note ?? null,
    createdBy: auth.user.id,
    expiresAt,
  });
  const url = `${context.webUrl}/invite/${encodeURIComponent(token)}`;
  const message = teamInvitationEmail(org.name, context.inviterName, url);
  await context.sendMail({
    to: email,
    idempotencyKey: `admin-invitation:${invitation._id.toHexString()}`,
    ...message,
  });
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'invitation.created',
    targetType: 'invitation',
    targetId: invitation._id.toHexString(),
    organizationId: input.organizationId,
    siteId: input.siteId ?? null,
    requestId,
    summary: `Invited ${email} to ${org.name} as ${input.role}.`,
    meta: { role: input.role, expiresAt: expiresAt.toISOString() },
  });
  return {
    ok: true as const,
    email,
    role: input.role,
    expiresAt: expiresAt.toISOString(),
    developmentToken: context.allowDevToken ? token : null,
  };
}

/** Admin-only. Owners cannot create owners; only a platform admin can. */
export async function inviteOrganizationMemberAdmin(
  db: Database,
  auth: AuthContext,
  organizationId: ObjectId,
  input: {
    email: string;
    role: 'SITE_OWNER' | 'STAFF';
    siteId?: ObjectId;
    note?: string;
  },
  context: AdminInviteDeps,
  requestId: string,
) {
  return issueAdminInvitation(
    db,
    auth,
    { ...input, organizationId },
    context,
    requestId,
  );
}

/** Admin-only creation of another platform administrator. */
export async function invitePlatformAdmin(
  db: Database,
  auth: AuthContext,
  input: { email: string; organizationId: string; note?: string },
  context: AdminInviteDeps,
  requestId: string,
) {
  return issueAdminInvitation(
    db,
    auth,
    {
      email: input.email,
      organizationId: new ObjectId(input.organizationId),
      role: 'PLATFORM_ADMIN',
      note: input.note,
    },
    context,
    requestId,
  );
}
