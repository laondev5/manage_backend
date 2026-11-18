import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import {
  AppError,
  conflict,
  forbidden,
  notFound,
  sitePolicySchema,
  type AssignmentRemoveInput,
  type InvitationSummary,
  type RosterEntry,
  type SiteCreateInput,
  type SiteDetail,
  type SiteSummary,
  type SiteUpdateInput,
} from '../contracts/index.js';
import { canManageSite, canReadSite } from '../domain/index.js';
import {
  acceptAssignment,
  appendAudit,
  createAssignment,
  createInvitation,
  createMembership,
  createSite,
  endAssignment,
  findActiveAssignment,
  findActiveMembership,
  findInvitationByTokenHash,
  findSite,
  findSitesByIds,
  listInvitationsForSite,
  listRoster,
  listSitesScoped,
  markInvitationAccepted,
  revokeInvitation,
  sha256,
  siteCounts,
  updateSite,
  usersByIds,
  withTransaction,
  type Database,
  type InvitationDoc,
  type SiteDoc,
} from '../database/index.js';
import type { AuthContext } from '../http/context.js';
import { invitationEmail, teamInvitationEmail } from '../mail.js';
import { siteToDetail, siteToSummary } from './mapping.js';

async function siteStaffNames(db: Database, sites: SiteDoc[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      sites
        .flatMap((site) => [site.teamLeadId, site.inspectorId])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (!ids.length) return new Map();
  const users = await usersByIds(db.c, ids);
  return new Map([...users.entries()].map(([id, user]) => [id, user.name]));
}

export async function listSites(
  db: Database,
  auth: AuthContext,
  scope: 'current' | 'previous' = 'current',
): Promise<SiteSummary[]> {
  const sites = await listSitesScoped(db.c, {
    userId: auth.user.id,
    ownedSiteIds: auth.actor.ownedSiteIds,
    assignedSiteIds: auth.actor.assignedSiteIds,
    adminOrganizationIds: auth.actor.adminOrganizationIds,
    archived: scope === 'previous',
  });
  const [counts, names] = await Promise.all([
    siteCounts(db.c, sites.map((site) => site._id)),
    siteStaffNames(db, sites),
  ]);
  const assignments = sites.length
    ? await db.c.assignments
        .find({
          memberId: auth.user.id,
          effectiveTo: null,
          siteId: { $in: sites.map((site) => site._id) },
        })
        .toArray()
    : [];
  const acceptedBySite = new Map(
    assignments.map((assignment) => [
      assignment.siteId.toHexString(),
      assignment.acceptedAt?.toISOString() ?? null,
    ]),
  );
  return sites.map((site) =>
    siteToSummary(site, counts.get(site._id.toHexString()), {
      teamLeadName: site.teamLeadId ? (names.get(site.teamLeadId) ?? null) : null,
      inspectorName: site.inspectorId ? (names.get(site.inspectorId) ?? null) : null,
      ...(acceptedBySite.has(site._id.toHexString())
        ? { assignmentAcceptedAt: acceptedBySite.get(site._id.toHexString()) ?? null }
        : {}),
    }),
  );
}

export async function getSite(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
): Promise<SiteDetail> {
  const site = await findSite(db.c, siteId);
  if (!site || site.deletedAt) throw notFound('Site not found.');
  if (
    !canReadSite(auth.actor, {
      organizationId: site.organizationId.toHexString(),
      id: site._id.toHexString(),
    })
  ) {
    throw notFound('Site not found.');
  }
  const isAssigned = auth.actor.assignedSiteIds.includes(site._id.toHexString());
  const namedIds = [site.teamLeadId, site.inspectorId].filter((id): id is string => Boolean(id));
  const users = namedIds.length ? await usersByIds(db.c, [...new Set(namedIds)]) : null;
  const assignment = isAssigned
    ? await findActiveAssignment(db.c, site._id, auth.user.id)
    : null;
  return siteToDetail(site, {
    teamLeadName: site.teamLeadId ? (users?.get(site.teamLeadId)?.name ?? null) : null,
    inspectorName: site.inspectorId ? (users?.get(site.inspectorId)?.name ?? null) : null,
    ...(isAssigned
      ? { assignmentAcceptedAt: assignment?.acceptedAt?.toISOString() ?? null }
      : {}),
  });
}

export async function createOwnerSite(
  db: Database,
  auth: AuthContext,
  input: SiteCreateInput,
  requestId: string,
): Promise<SiteDetail> {
  if (!auth.actor.ownedOrganizationIds.includes(input.organizationId)) {
    throw forbidden('You can only create sites for an organization you own.');
  }
  if (!auth.capabilities.includes('owner.sites')) {
    throw forbidden('Site management is not available for this account.');
  }
  const site = await createSite(db.c, {
    organizationId: new ObjectId(input.organizationId),
    name: input.name,
    address: input.address,
    latitude: input.latitude,
    longitude: input.longitude,
    timezone: input.timezone,
    policy: sitePolicySchema.parse(input.policy),
    expectedHours: input.expectedHours ?? null,
    notificationPreferences: input.notificationPreferences ?? {
      email: true,
      push: true,
      onDutyAlerts: true,
    },
    ownerIds: [auth.user.id],
    createdBy: auth.user.id,
  });
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'site.created',
    targetType: 'site',
    targetId: site._id.toHexString(),
    organizationId: site.organizationId,
    siteId: site._id,
    requestId,
    summary: `Created site ${site.name}.`,
    meta: { radiusMeters: site.policy.radiusMeters, timezone: site.timezone },
  });
  return siteToDetail(site);
}

export async function updateOwnerSite(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  input: SiteUpdateInput,
  requestId: string,
): Promise<SiteDetail> {
  const site = await findSite(db.c, siteId);
  if (!site) throw notFound('Site not found.');
  if (
    !canManageSite(auth.actor, {
      organizationId: site.organizationId.toHexString(),
      id: site._id.toHexString(),
    })
  ) {
    throw notFound('Site not found.');
  }
  const mergedPolicy = input.policy
    ? sitePolicySchema.parse({ ...site.policy, ...input.policy })
    : undefined;
  const mergedPreferences = input.notificationPreferences
    ? { ...site.notificationPreferences, ...input.notificationPreferences }
    : undefined;
  const updated = await updateSite(db.c, {
    site,
    expectedVersion: input.version,
    actorId: auth.user.id,
    patch: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
      ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(mergedPolicy ? { policy: mergedPolicy } : {}),
      ...(input.expectedHours !== undefined ? { expectedHours: input.expectedHours } : {}),
      ...(mergedPreferences ? { notificationPreferences: mergedPreferences } : {}),
    },
  });
  if (!updated) {
    throw conflict('This site changed since you loaded it. Refresh and try again.', 'STALE_VERSION');
  }
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: mergedPolicy ? 'site.policy_updated' : 'site.updated',
    targetType: 'site',
    targetId: updated._id.toHexString(),
    organizationId: updated.organizationId,
    siteId: updated._id,
    requestId,
    summary: mergedPolicy
      ? `Updated the boundary policy for ${updated.name} to version ${updated.policyVersion}.`
      : `Updated site ${updated.name}.`,
    meta: { policyVersion: updated.policyVersion, radiusMeters: updated.policy.radiusMeters },
  });
  return siteToDetail(updated);
}

async function managedSite(db: Database, auth: AuthContext, siteId: ObjectId): Promise<SiteDoc> {
  const site = await findSite(db.c, siteId);
  if (!site) throw notFound('Site not found.');
  if (site.deletedAt) throw notFound('Site not found.');
  if (
    !canManageSite(auth.actor, {
      organizationId: site.organizationId.toHexString(),
      id: site._id.toHexString(),
    })
  ) {
    throw notFound('Site not found.');
  }
  return site;
}

export async function changeSiteLifecycle(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  input: { action: 'archive' | 'restore' | 'delete'; version: number; note?: string },
  requestId: string,
): Promise<SiteDetail> {
  const site = await managedSite(db, auth, siteId);
  if (!auth.capabilities.includes('owner.sites') && !auth.capabilities.includes('admin.sites')) {
    throw forbidden('Site management is not available for this account.');
  }
  if (input.action === 'restore' && !site.archivedAt) {
    throw conflict('This site is already active.');
  }
  if (input.action !== 'restore' && site.archivedAt) {
    throw conflict(
      input.action === 'delete'
        ? 'Restore the site before deleting it.'
        : 'This site is already archived.',
    );
  }
  const working = await db.c.shifts.countDocuments({ siteId: site._id, status: 'WORKING' });
  if (working > 0 && input.action !== 'restore') {
    throw conflict(
      input.action === 'delete'
        ? 'Someone is still clocked in at this site. End the shift before deleting.'
        : 'Someone is still clocked in at this site. End the shift before archiving.',
    );
  }

  const now = new Date();
  const $set: Record<string, unknown> = { updatedAt: now };
  if (input.action === 'archive') {
    $set.archivedAt = now;
    $set.status = 'INACTIVE';
  } else if (input.action === 'restore') {
    $set.archivedAt = null;
    $set.deletedAt = null;
    $set.status = 'ACTIVE';
  } else {
    $set.deletedAt = now;
    $set.status = 'INACTIVE';
  }

  const updated = await db.c.sites.findOneAndUpdate(
    { _id: site._id, version: input.version },
    { $set, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  if (!updated) {
    throw conflict('This site changed since you loaded it. Refresh and try again.', 'STALE_VERSION');
  }

  if (input.action !== 'restore') {
    await db.c.invitations.updateMany(
      { siteId: site._id, status: 'PENDING' },
      { $set: { status: 'REVOKED' } },
    );
  }

  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: `site.${input.action === 'delete' ? 'deleted' : input.action === 'archive' ? 'archived' : 'restored'}`,
    targetType: 'site',
    targetId: updated._id.toHexString(),
    organizationId: updated.organizationId,
    siteId: updated._id,
    requestId,
    summary:
      input.action === 'archive'
        ? `Archived site ${updated.name}.`
        : input.action === 'restore'
          ? `Restored site ${updated.name}.`
          : `Deleted site ${updated.name}.`,
    meta: { note: input.note ?? null },
  });
  return siteToDetail(updated);
}

export async function siteRoster(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
): Promise<RosterEntry[]> {
  const site = await managedSite(db, auth, siteId);
  const roster = await listRoster(db.c, site._id);
  return roster.map((entry) => ({
    memberId: entry.assignment.memberId,
    assignmentId: entry.assignment._id.toHexString(),
    name: entry.name,
    email: entry.email,
    role: entry.membership?.role ?? 'STAFF',
    status: entry.membership?.status ?? 'REVOKED',
    assignedAt: entry.assignment.effectiveFrom.toISOString(),
    acceptedAt: entry.assignment.acceptedAt?.toISOString() ?? null,
    isTeamLead: site.teamLeadId === entry.assignment.memberId,
    presence: entry.shift ? entry.shift.presence.state : 'NOT_WORKING',
    shiftId: entry.shift?._id.toHexString() ?? null,
    clockedInAt: entry.shift?.startedAt.toISOString() ?? null,
    lastUpdateAt: entry.shift?.presence.lastQualifiedAt?.toISOString() ?? null,
  }));
}

export async function addAssignment(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  input: { memberId: string; permissionScope: 'CLOCK_ONLY' | 'CLOCK_AND_HISTORY'; effectiveFrom?: string },
  requestId: string,
) {
  const site = await managedSite(db, auth, siteId);
  const membership = await findActiveMembership(db.c, site.organizationId, input.memberId);
  if (!membership || membership.role !== 'STAFF') {
    throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active staff member in this organization.', {
      memberId: ['The member is not active staff in this organization.'],
    });
  }
  const existing = await findActiveAssignment(db.c, site._id, input.memberId);
  if (existing) throw conflict('This member is already assigned to the site.');
  const assignment = await createAssignment(db.c, {
    organizationId: site.organizationId,
    siteId: site._id,
    memberId: input.memberId,
    membershipId: membership._id,
    permissionScope: input.permissionScope,
    effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : undefined,
    createdBy: auth.user.id,
  });
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'assignment.created',
    targetType: 'assignment',
    targetId: assignment._id.toHexString(),
    organizationId: site.organizationId,
    siteId: site._id,
    requestId,
    summary: 'Assigned a staff member to the site.',
    meta: { memberId: input.memberId, permissionScope: input.permissionScope },
  });
  return {
    id: assignment._id.toHexString(),
    memberId: assignment.memberId,
    siteId: assignment.siteId.toHexString(),
    effectiveFrom: assignment.effectiveFrom.toISOString(),
    permissionScope: assignment.permissionScope,
  };
}

export async function removeAssignment(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  assignmentId: ObjectId,
  input: AssignmentRemoveInput,
  requestId: string,
) {
  const site = await managedSite(db, auth, siteId);
  const assignment = await db.c.assignments.findOne({ _id: assignmentId, siteId: site._id });
  if (!assignment) throw notFound('Assignment not found.');
  const working = await db.c.shifts.countDocuments({
    siteId: site._id,
    userId: assignment.memberId,
    status: 'WORKING',
  });
  if (working > 0) {
    throw conflict('This member is still clocked in at this site. End the shift before removing them.');
  }
  const ended = await endAssignment(db.c, assignment._id, auth.user.id);
  if (!ended) throw conflict('This assignment was already ended.');
  if (site.teamLeadId === assignment.memberId) {
    await db.c.sites.updateOne(
      { _id: site._id, teamLeadId: assignment.memberId },
      { $set: { teamLeadId: null, updatedAt: new Date() } },
    );
  }
  if (site.inspectorId === assignment.memberId) {
    await db.c.sites.updateOne(
      { _id: site._id, inspectorId: assignment.memberId },
      { $set: { inspectorId: null, updatedAt: new Date() } },
    );
  }
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'assignment.ended',
    targetType: 'assignment',
    targetId: assignment._id.toHexString(),
    organizationId: site.organizationId,
    siteId: site._id,
    requestId,
    summary: 'Removed a staff member from the site roster.',
    meta: { memberId: assignment.memberId, reason: input.reason ?? 'Removed from site.' },
  });
  return { ok: true as const };
}

export async function acceptSiteAssignment(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  requestId: string,
): Promise<{ siteId: string; acceptedAt: string }> {
  const site = await findSite(db.c, siteId);
  if (!site || site.deletedAt) throw notFound('Site not found.');
  const assignment = await findActiveAssignment(db.c, site._id, auth.user.id);
  if (!assignment) throw notFound('You are not assigned to this site.');
  if (assignment.acceptedAt) {
    return { siteId: site._id.toHexString(), acceptedAt: assignment.acceptedAt.toISOString() };
  }
  const now = new Date();
  const accepted = await acceptAssignment(db.c, assignment._id, auth.user.id, now);
  if (!accepted) {
    const current = await findActiveAssignment(db.c, site._id, auth.user.id);
    if (!current?.acceptedAt) {
      throw conflict('This assignment could not be accepted. Refresh and try again.');
    }
    return { siteId: site._id.toHexString(), acceptedAt: current.acceptedAt.toISOString() };
  }
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'assignment.accepted',
    targetType: 'assignment',
    targetId: assignment._id.toHexString(),
    organizationId: site.organizationId,
    siteId: site._id,
    requestId,
    summary: `Accepted the assignment to ${site.name}.`,
    meta: {},
  });
  return { siteId: site._id.toHexString(), acceptedAt: now.toISOString() };
}

export async function setSiteTeamLead(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  input: { memberId: string | null },
  requestId: string,
): Promise<{ siteId: string; teamLeadId: string | null; teamLeadName: string | null }> {
  const site = await managedSite(db, auth, siteId);
  if (!auth.capabilities.includes('owner.sites')) {
    throw forbidden('Site management is not available for this account.');
  }
  const now = new Date();
  if (input.memberId === null) {
    await db.c.sites.updateOne(
      { _id: site._id },
      { $set: { teamLeadId: null, updatedAt: now } },
    );
    await appendAudit(db.c, {
      actorId: auth.user.id,
      actorName: auth.user.name,
      actorRole: auth.roles[0] ?? null,
      action: 'site.team_lead_cleared',
      targetType: 'site',
      targetId: site._id.toHexString(),
      organizationId: site.organizationId,
      siteId: site._id,
      requestId,
      summary: `Cleared the team lead for ${site.name}.`,
      meta: {},
    });
    return { siteId: site._id.toHexString(), teamLeadId: null, teamLeadName: null };
  }

  const membership = await findActiveMembership(db.c, site.organizationId, input.memberId);
  if (!membership || membership.role !== 'STAFF') {
    throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active staff member in this organization.', {
      memberId: ['The member is not active staff in this organization.'],
    });
  }
  const assignment = await findActiveAssignment(db.c, site._id, input.memberId);
  if (!assignment) {
    throw new AppError(422, 'VALIDATION_ERROR', 'The team lead must be assigned to this site.', {
      memberId: ['Assign the member to the site before making them team lead.'],
    });
  }
  await db.c.sites.updateOne(
    { _id: site._id },
    { $set: { teamLeadId: input.memberId, updatedAt: now } },
  );
  const users = await usersByIds(db.c, [input.memberId]);
  const teamLeadName = users.get(input.memberId)?.name ?? null;
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'site.team_lead_set',
    targetType: 'site',
    targetId: site._id.toHexString(),
    organizationId: site.organizationId,
    siteId: site._id,
    requestId,
    summary: `Set ${teamLeadName ?? 'a team member'} as team lead for ${site.name}.`,
    meta: { memberId: input.memberId },
  });
  return { siteId: site._id.toHexString(), teamLeadId: input.memberId, teamLeadName };
}

export async function setSiteInspector(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  input: { inspectorId: string | null },
  requestId: string,
): Promise<{ siteId: string; inspectorId: string | null; inspectorName: string | null; inspectingSelf: boolean }> {
  const site = await managedSite(db, auth, siteId);
  if (!auth.capabilities.includes('owner.sites')) {
    throw forbidden('Site management is not available for this account.');
  }
  const now = new Date();
  if (input.inspectorId === null) {
    await db.c.sites.updateOne(
      { _id: site._id },
      { $set: { inspectorId: null, updatedAt: now } },
    );
    await appendAudit(db.c, {
      actorId: auth.user.id,
      actorName: auth.user.name,
      actorRole: auth.roles[0] ?? null,
      action: 'site.inspector_cleared',
      targetType: 'site',
      targetId: site._id.toHexString(),
      organizationId: site.organizationId,
      siteId: site._id,
      requestId,
      summary: `Cleared the site inspector for ${site.name}.`,
      meta: {},
    });
    return {
      siteId: site._id.toHexString(),
      inspectorId: null,
      inspectorName: null,
      inspectingSelf: false,
    };
  }

  const inspectingSelf = input.inspectorId === auth.user.id;
  if (!inspectingSelf) {
    const membership = await findActiveMembership(db.c, site.organizationId, input.inspectorId);
    if (!membership || membership.role !== 'STAFF') {
      throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active staff member in this organization.', {
        inspectorId: ['The inspector is not active staff in this organization.'],
      });
    }
    const assignment = await findActiveAssignment(db.c, site._id, input.inspectorId);
    if (!assignment) {
      throw new AppError(422, 'VALIDATION_ERROR', 'The inspector must be assigned to this site.', {
        inspectorId: ['Assign the member to the site before making them inspector.'],
      });
    }
  }
  await db.c.sites.updateOne(
    { _id: site._id },
    { $set: { inspectorId: input.inspectorId, updatedAt: now } },
  );
  const users = await usersByIds(db.c, [input.inspectorId]);
  const inspectorName = users.get(input.inspectorId)?.name ?? auth.user.name;
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'site.inspector_set',
    targetType: 'site',
    targetId: site._id.toHexString(),
    organizationId: site.organizationId,
    siteId: site._id,
    requestId,
    summary: inspectingSelf
      ? `Chose to inspect ${site.name} personally.`
      : `Assigned ${inspectorName} as site inspector for ${site.name}.`,
    meta: { inspectorId: input.inspectorId, self: inspectingSelf },
  });
  return {
    siteId: site._id.toHexString(),
    inspectorId: input.inspectorId,
    inspectorName,
    inspectingSelf,
  };
}

function toInvitationSummary(doc: InvitationDoc, site: SiteDoc | null): InvitationSummary {
  const expired = doc.status === 'PENDING' && doc.expiresAt.getTime() <= Date.now();
  return {
    id: doc._id.toHexString(),
    email: doc.email,
    siteId: doc.siteId?.toHexString() ?? null,
    siteName: site?.name ?? null,
    organizationId: doc.organizationId.toHexString(),
    role: doc.role,
    status: expired ? 'EXPIRED' : doc.status,
    createdAt: doc.createdAt.toISOString(),
    expiresAt: doc.expiresAt.toISOString(),
    acceptedAt: doc.acceptedAt?.toISOString() ?? null,
  };
}

export async function listSiteInvitations(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
): Promise<InvitationSummary[]> {
  const site = await managedSite(db, auth, siteId);
  const docs = await listInvitationsForSite(db.c, site._id);
  return docs.map((doc) => toInvitationSummary(doc, site));
}

export async function listTeamInvitations(
  db: Database,
  auth: AuthContext,
): Promise<InvitationSummary[]> {
  if (!auth.capabilities.includes('owner.team')) {
    throw forbidden('Team invitations are not available for this account.');
  }
  const orgIds = auth.actor.ownedOrganizationIds.map((id) => new ObjectId(id));
  if (!orgIds.length) return [];
  const docs = await db.c.invitations
    .find({ organizationId: { $in: orgIds }, siteId: null })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  return docs.map((doc) => toInvitationSummary(doc, null));
}

export type InviteResult = {
  invitation: InvitationSummary;
  developmentToken: string | null;
  token: string;
};

export async function inviteStaff(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  input: { email: string; note?: string },
  context: {
    requestId: string;
    webUrl: string;
    allowDevToken: boolean;
    sendMail: (message: { to: string; subject: string; text: string; html: string; idempotencyKey: string }) => Promise<unknown>;
    inviterName: string;
  },
): Promise<InviteResult> {
  const site = await managedSite(db, auth, siteId);
  if (!auth.capabilities.includes('owner.team')) {
    throw forbidden('Team invitations are not available for this account.');
  }
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const invitation = await createInvitation(db.c, {
    organizationId: site.organizationId,
    siteId: site._id,
    email: input.email,
    tokenHash: sha256(token),
    note: input.note ?? null,
    createdBy: auth.user.id,
    expiresAt,
  });
  const url = `${context.webUrl}/invite/${encodeURIComponent(token)}`;
  const message = invitationEmail(site.name, context.inviterName, url);
  await context.sendMail({
    to: input.email,
    idempotencyKey: `invitation:${invitation._id.toHexString()}`,
    ...message,
  });
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'invitation.created',
    targetType: 'invitation',
    targetId: invitation._id.toHexString(),
    organizationId: site.organizationId,
    siteId: site._id,
    requestId: context.requestId,
    summary: `Invited a staff member to ${site.name}.`,
    meta: { expiresAt: expiresAt.toISOString() },
  });
  return {
    invitation: toInvitationSummary(invitation, site),
    developmentToken: context.allowDevToken ? token : null,
    token,
  };
}

export async function revokeSiteInvitation(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  invitationId: ObjectId,
) {
  await managedSite(db, auth, siteId);
  const invitation = await db.c.invitations.findOne({ _id: invitationId, siteId });
  if (!invitation) throw notFound('Pending invitation not found.');
  const result = await revokeInvitation(db.c, invitationId);
  if (!result.modifiedCount) throw notFound('Pending invitation not found.');
  return { ok: true as const };
}

export async function inviteTeamMember(
  db: Database,
  auth: AuthContext,
  input: { email: string; note?: string; siteId?: string },
  context: {
    requestId: string;
    webUrl: string;
    allowDevToken: boolean;
    sendMail: (message: { to: string; subject: string; text: string; html: string; idempotencyKey: string }) => Promise<unknown>;
    inviterName: string;
  },
): Promise<InviteResult> {
  if (!auth.capabilities.includes('owner.team')) {
    throw forbidden('Team invitations are not available for this account.');
  }
  const organizationId = auth.actor.ownedOrganizationIds[0];
  if (!organizationId) throw forbidden('Only a site owner can invite team members.');

  let site: SiteDoc | null = null;
  if (input.siteId) {
    site = await managedSite(db, auth, new ObjectId(input.siteId));
    if (site.organizationId.toHexString() !== organizationId) {
      throw forbidden('You can only invite members to sites you manage.');
    }
  }

  const organization = await db.c.organizations.findOne({ _id: new ObjectId(organizationId) });
  if (!organization) throw notFound('Organization not found.');

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const invitation = await createInvitation(db.c, {
    organizationId: new ObjectId(organizationId),
    siteId: site?._id ?? null,
    email: input.email,
    tokenHash: sha256(token),
    note: input.note ?? null,
    createdBy: auth.user.id,
    expiresAt,
  });
  const url = `${context.webUrl}/invite/${encodeURIComponent(token)}`;
  const message = site
    ? invitationEmail(site.name, context.inviterName, url)
    : teamInvitationEmail(organization.name, context.inviterName, url);
  await context.sendMail({
    to: input.email,
    idempotencyKey: `invitation:${invitation._id.toHexString()}`,
    ...message,
  });
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'invitation.created',
    targetType: 'invitation',
    targetId: invitation._id.toHexString(),
    organizationId: invitation.organizationId,
    siteId: site?._id ?? null,
    requestId: context.requestId,
    summary: site
      ? `Invited a staff member to ${site.name}.`
      : `Invited a staff member to the general team.`,
    meta: { expiresAt: expiresAt.toISOString(), scope: site ? 'SITE' : 'TEAM' },
  });
  return {
    invitation: toInvitationSummary(invitation, site),
    developmentToken: context.allowDevToken ? token : null,
    token,
  };
}

export async function revokeTeamInvitation(
  db: Database,
  auth: AuthContext,
  invitationId: ObjectId,
) {
  if (!auth.capabilities.includes('owner.team')) {
    throw forbidden('Team invitations are not available for this account.');
  }
  const invitation = await db.c.invitations.findOne({
    _id: invitationId,
    siteId: null,
    organizationId: { $in: auth.actor.ownedOrganizationIds.map((id) => new ObjectId(id)) },
  });
  if (!invitation) throw notFound('Pending invitation not found.');
  const result = await revokeInvitation(db.c, invitationId);
  if (!result.modifiedCount) throw notFound('Pending invitation not found.');
  return { ok: true as const };
}

export function invitationPreview(
  invitation: InvitationDoc,
  site: SiteDoc | null,
  organizationName: string,
) {
  return {
    email: invitation.email,
    siteName: site?.name ?? null,
    organizationName,
    expiresAt: invitation.expiresAt.toISOString(),
    status:
      invitation.status === 'PENDING' && invitation.expiresAt.getTime() <= Date.now()
        ? ('EXPIRED' as const)
        : invitation.status,
    note: invitation.note,
  };
}

export async function lookupInvitation(db: Database, token: string) {
  const invitation = await findInvitationByTokenHash(db.c, sha256(token));
  if (!invitation) throw new AppError(404, 'INVITATION_INVALID', 'This invitation link is not valid.');
  const site = invitation.siteId ? await findSite(db.c, invitation.siteId) : null;
  if (invitation.siteId && !site) {
    throw new AppError(404, 'INVITATION_INVALID', 'This invitation link is not valid.');
  }
  if (site?.deletedAt) throw new AppError(404, 'INVITATION_INVALID', 'This invitation link is not valid.');
  const organization = await db.c.organizations.findOne({ _id: invitation.organizationId });
  return { invitation, site, organizationName: organization?.name ?? 'Organization' };
}

export async function acceptInvitationWorkflow(
  db: Database,
  input: { token: string; name: string; password: string; userId: string },
  context: { requestId: string },
) {
  const invitation = await findInvitationByTokenHash(db.c, sha256(input.token));
  if (!invitation) throw new AppError(404, 'INVITATION_INVALID', 'This invitation link is not valid.');
  if (invitation.status !== 'PENDING') {
    throw new AppError(409, 'INVITATION_INVALID', 'This invitation has already been used or revoked.');
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    await db.c.invitations.updateOne({ _id: invitation._id }, { $set: { status: 'EXPIRED' } });
    throw new AppError(410, 'INVITATION_EXPIRED', 'This invitation has expired. Ask for a new invitation.');
  }
  const site = invitation.siteId ? await findSite(db.c, invitation.siteId) : null;
  if (invitation.siteId && (!site || site.deletedAt)) {
    throw new AppError(404, 'INVITATION_INVALID', 'This invitation link is not valid.');
  }

  let consumedHere = false;
  try {
    await withTransaction(db, async (session) => {
      const consumed = await markInvitationAccepted(db.c, invitation._id, input.userId, session);
      if (!consumed) throw conflict('This invitation has already been used.');
      consumedHere = true;
      const existing = await findActiveMembership(db.c, invitation.organizationId, input.userId);
      const membership =
        existing ??
        (await createMembership(
          db.c,
          {
            organizationId: invitation.organizationId,
            userId: input.userId,
            role: invitation.role,
          },
          session,
        ));
      if (site) {
        const assignment = await findActiveAssignment(db.c, site._id, input.userId);
        if (!assignment) {
          await createAssignment(
            db.c,
            {
              organizationId: invitation.organizationId,
              siteId: site._id,
              memberId: input.userId,
              membershipId: membership._id,
              permissionScope: 'CLOCK_AND_HISTORY',
              acceptedAt: new Date(),
              createdBy: invitation.createdBy,
            },
            session,
          );
        }
      }
    });
  } catch (error) {
    if (db.supportsTransactions === false && consumedHere) {
      // Without a transaction the token stays consumed even though membership
      // or assignment failed; release it so the invitee can retry. A partially
      // created membership is reused idempotently on the next attempt.
      await db.c.invitations
        .updateOne(
          { _id: invitation._id, status: 'ACCEPTED', acceptedBy: input.userId },
          { $set: { status: 'PENDING', acceptedAt: null, acceptedBy: null } },
        )
        .catch(() => undefined);
    }
    throw error;
  }

  await appendAudit(db.c, {
    actorId: input.userId,
    actorName: input.name,
    actorRole: invitation.role,
    action: 'invitation.accepted',
    targetType: 'invitation',
    targetId: invitation._id.toHexString(),
    organizationId: invitation.organizationId,
    siteId: invitation.siteId,
    requestId: context.requestId,
    summary: site ? `Accepted a staff invitation for ${site.name}.` : 'Accepted a general team invitation.',
    meta: {},
  });
  return { siteName: site?.name ?? null, organizationId: invitation.organizationId.toHexString() };
}

export async function staffAssignedSites(db: Database, auth: AuthContext) {
  const now = new Date();
  const allowedSiteIds = new Set(auth.actor.assignedSiteIds);
  const assignments = (
    await db.c.assignments
      .find({
        memberId: auth.user.id,
        effectiveFrom: { $lte: now },
        $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
      })
      .toArray()
  ).filter((assignment) => allowedSiteIds.has(assignment.siteId.toHexString()));
  if (!assignments.length) return [];
  const sites = await findSitesByIds(db.c, assignments.map((assignment) => assignment.siteId));
  const live = sites.filter((site) => !site.deletedAt && !site.archivedAt);
  const assignmentBySite = new Map(
    assignments.map((assignment) => [assignment.siteId.toHexString(), assignment]),
  );
  const names = await siteStaffNames(db, live);
  return live
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((site) => {
      const assignment = assignmentBySite.get(site._id.toHexString());
      return siteToSummary(site, undefined, {
        teamLeadName: site.teamLeadId ? (names.get(site.teamLeadId) ?? null) : null,
        inspectorName: site.inspectorId ? (names.get(site.inspectorId) ?? null) : null,
        assignmentAcceptedAt: assignment?.acceptedAt?.toISOString() ?? null,
      });
    });
}

export async function orgMemberLookup(db: Database, organizationId: ObjectId, query: string) {
  const memberships = await db.c.memberships
    .find({ organizationId, role: 'STAFF', status: 'ACTIVE' })
    .limit(100)
    .toArray();
  const users = await usersByIds(db.c, memberships.map((membership) => membership.userId));
  const needle = query.trim().toLowerCase();
  return memberships
    .map((membership) => {
      const user = users.get(membership.userId);
      return user
        ? {
            memberId: membership.userId,
            name: user.name,
            email: user.email,
          }
        : null;
    })
    .filter((entry): entry is { memberId: string; name: string; email: string } => entry !== null)
    .filter(
      (entry) =>
        !needle || entry.name.toLowerCase().includes(needle) || entry.email.toLowerCase().includes(needle),
    );
}
