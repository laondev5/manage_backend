import { ObjectId } from 'mongodb';
import {
  conflict,
  forbidden,
  notFound,
  type MemberQueryInput,
  type MemberRemoval,
  type MemberRemovalSummary,
  type MemberStatusUpdate,
  type TeamMemberDetail,
  type TeamMemberSummary,
} from '../contracts/index.js';
import {
  appendAudit,
  listShiftsForSites,
  usersByIds,
  type Database,
  type MembershipDoc,
  type ShiftDoc,
  type SiteDoc,
  withTransaction,
} from '../database/index.js';
import type { AuthContext } from '../http/context.js';
import { purgeStaffMember } from './purge.js';

const QUERY_LIMIT = 50;
const SHIFT_DAYS = 90;

function requireTeam(auth: AuthContext) {
  if (!auth.capabilities.includes('owner.team')) {
    throw forbidden('Team management is not available for this account.');
  }
}

async function ownedMembership(
  db: Database,
  auth: AuthContext,
  memberId: string,
): Promise<MembershipDoc> {
  requireTeam(auth);
  const orgIds = auth.actor.ownedOrganizationIds.map((id) => new ObjectId(id));
  if (!orgIds.length) throw notFound('Member not found.');
  const membership = await db.c.memberships.findOne({
    userId: memberId,
    organizationId: { $in: orgIds },
    role: { $in: ['STAFF', 'SUPERVISOR'] },
    status: { $in: ['ACTIVE', 'SUSPENDED'] },
  });
  if (!membership) throw notFound('Member not found.');
  return membership;
}

const activeAssignments = (now: Date) => ({
  effectiveFrom: { $lte: now },
  $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
});

type MemberSiteRow = {
  assignmentId: string,
  id: string;
  name: string;
  presence: TeamMemberSummary['sites'][number]['presence'];
  clockedInAt: string | null;
  shiftId: string | null;
  assignedAt: Date;
};

async function memberSiteRows(
  db: Database,
  memberIds: string[],
  siteIds: ObjectId[],
  now: Date,
): Promise<Map<string, MemberSiteRow[]>> {
  const result = new Map<string, MemberSiteRow[]>();
  if (!memberIds.length || !siteIds.length) return result;
  const assignments = await db.c.assignments
    .find({ memberId: { $in: memberIds }, siteId: { $in: siteIds }, ...activeAssignments(now) })
    .toArray();
  if (!assignments.length) return result;
  const sites = await db.c.sites
    .find({ _id: { $in: assignments.map((assignment) => assignment.siteId) }, deletedAt: null })
    .toArray();
  const siteById = new Map(sites.map((site) => [site._id.toHexString(), site]));
  const shifts = await db.c.shifts
    .find({
      userId: { $in: memberIds },
      status: 'WORKING',
      siteId: { $in: [...siteById.values()].map((site) => site._id) },
    })
    .toArray();
  const shiftByKey = new Map(shifts.map((shift) => [`${shift.userId}:${shift.siteId.toHexString()}`, shift]));
  for (const assignment of assignments) {
    const site = siteById.get(assignment.siteId.toHexString());
    if (!site) continue;
    const shift = shiftByKey.get(`${assignment.memberId}:${site._id.toHexString()}`) ?? null;
    const rows = result.get(assignment.memberId) ?? [];
    rows.push({
      assignmentId: assignment._id.toHexString(),
      id: site._id.toHexString(),
      name: site.name,
      presence: shift ? shift.presence.state : 'NOT_WORKING',
      clockedInAt: shift?.startedAt.toISOString() ?? null,
      shiftId: shift?._id.toHexString() ?? null,
      assignedAt: assignment.effectiveFrom,
    });
    result.set(assignment.memberId, rows);
  }
  return result;
}

function sortSites(rows: MemberSiteRow[]): MemberSiteRow[] {
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

export async function teamMembers(db: Database, auth: AuthContext): Promise<TeamMemberSummary[]> {
  requireTeam(auth);
  const orgIds = auth.actor.ownedOrganizationIds.map((id) => new ObjectId(id));
  if (!orgIds.length) return [];
  const memberships = await db.c.memberships
    .find({ organizationId: { $in: orgIds }, role: { $in: ['STAFF', 'SUPERVISOR'] }, status: { $in: ['ACTIVE', 'SUSPENDED'] } })
    .sort({ createdAt: 1 })
    .limit(500)
    .toArray();
  if (!memberships.length) return [];
  const users = await usersByIds(
    db.c,
    memberships.map((membership) => membership.userId),
  );
  const siteIds = auth.actor.ownedSiteIds.map((id) => new ObjectId(id));
  const sitesByMember = await memberSiteRows(
    db,
    memberships.map((membership) => membership.userId),
    siteIds,
    new Date(),
  );
  return memberships.map((membership) => {
    const user = users.get(membership.userId);
    const sites = sortSites(sitesByMember.get(membership.userId) ?? []);
    return {
      memberId: membership.userId,
      name: user?.name ?? 'Team member',
      email: user?.email ?? '',
      role: membership.role,
      phone: user?.phone ?? '',
      canUpdateSiteLocation: membership.canUpdateSiteLocation ?? false,
      title: membership.title,
      status: membership.status,
      membershipId: membership._id.toHexString(),
      membershipVersion: membership.version,
      joinedAt: membership.createdAt.toISOString(),
      sites: sites.map((site) => ({
        id: site.id,
        name: site.name,
        presence: site.presence,
        clockedInAt: site.clockedInAt,
        shiftId: site.shiftId,
      })),
    };
  });
}

type Scope = { membership: MembershipDoc; siteById: Map<string, SiteDoc> };

async function scopeFor(
  db: Database,
  auth: AuthContext,
  membership: MembershipDoc,
): Promise<Scope> {
  const siteIds = auth.actor.ownedSiteIds.map((id) => new ObjectId(id));
  const sites = siteIds.length
    ? await db.c.sites.find({ _id: { $in: siteIds } }).toArray()
    : [];
  return {
    membership,
    siteById: new Map(sites.map((site) => [site._id.toHexString(), site])),
  };
}

async function queriesFor(
  db: Database,
  memberId: string,
): Promise<TeamMemberDetail['queries']> {
  const docs = await db.c.auditEvents
    .find({ action: 'member.queried', targetType: 'member', targetId: memberId })
    .sort({ sequence: -1 })
    .limit(QUERY_LIMIT)
    .toArray();
  return docs.map((entry) => ({
    id: entry._id.toHexString(),
    at: entry.at.toISOString(),
    message: typeof entry.meta.message === 'string' ? entry.meta.message : entry.summary,
    byName: entry.actorName,
  }));
}

export async function teamMemberDetail(
  db: Database,
  auth: AuthContext,
  memberId: string,
): Promise<TeamMemberDetail> {
  const membership = await ownedMembership(db, auth, memberId);
  const { siteById } = await scopeFor(db, auth, membership);
  const siteIds = [...siteById.values()].map((site) => site._id);
  const now = new Date();

  const [users, sitesByMember, shiftPage, corrections, queries, openAlerts] = await Promise.all([
    usersByIds(db.c, [memberId]),
    memberSiteRows(db, [memberId], siteIds, now),
    listShiftsForSites(
      db.c,
      siteIds,
      {
        from: new Date(now.getTime() - SHIFT_DAYS * 24 * 60 * 60 * 1000),
        to: now,
        limit: 10,
      },
      memberId,
    ),
    db.c.corrections
      .find({ workerId: memberId, siteId: { $in: siteIds } })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray(),
    queriesFor(db, memberId),
    db.c.alerts.countDocuments({
      recipientId: auth.user.id,
      workerId: memberId,
      state: { $ne: 'REVIEWED' },
    }),
  ]);

  const user = users.get(memberId);
  const shifts = shiftPage.items as ShiftDoc[];
  const rows = sortSites(sitesByMember.get(memberId) ?? []);

  return {
    member: {
      id: memberId,
      name: user?.name ?? 'Team member',
      email: user?.email ?? '',
      role: membership.role,
      phone: user?.phone ?? '',
      canUpdateSiteLocation: membership.canUpdateSiteLocation ?? false,
      title: membership.title,
      status: membership.status,
      membershipId: membership._id.toHexString(),
      membershipVersion: membership.version,
      joinedAt: membership.createdAt.toISOString(),
    },
    sites: rows.map((site) => ({
      assignmentId: site.assignmentId,
      id: site.id,
      name: site.name,
      presence: site.presence,
      clockedInAt: site.clockedInAt,
      shiftId: site.shiftId,
      assignedAt: site.assignedAt.toISOString(),
    })),
    recentShifts: shifts.map((shift) => ({
      id: shift._id.toHexString(),
      siteId: shift.siteId.toHexString(),
      siteName: siteById.get(shift.siteId.toHexString())?.name ?? 'Archived site',
      startedAt: shift.startedAt.toISOString(),
      endedAt: shift.endedAt?.toISOString() ?? null,
      status: shift.status,
      reviewState: shift.reviewState,
      durationMinutes: shift.endedAt
        ? Math.max(0, Math.floor((shift.endedAt.getTime() - shift.startedAt.getTime()) / 60000))
        : null,
    })),
    corrections: corrections.map((correction) => ({
      id: correction._id.toHexString(),
      siteName: siteById.get(correction.siteId.toHexString())?.name ?? 'Archived site',
      status: correction.status,
      requestedAt: correction.createdAt.toISOString(),
      proposedStartAt: correction.proposedStartAt.toISOString(),
      proposedEndAt: correction.proposedEndAt?.toISOString() ?? null,
    })),
    queries,
    openAlerts,
  };
}

export async function setTeamMemberStatus(
  db: Database,
  auth: AuthContext,
  memberId: string,
  input: MemberStatusUpdate,
  requestId: string,
): Promise<TeamMemberDetail> {
  const membership = await ownedMembership(db, auth, memberId);
  if (membership.userId === auth.user.id) {
    throw conflict('You cannot change your own membership here.');
  }
  if (membership.status === 'REVOKED') {
    throw conflict('This membership was revoked and cannot be reactivated here.');
  }
  const now = new Date();
  const updated = await db.c.memberships.findOneAndUpdate(
    { _id: membership._id, version: input.expectedVersion, status: { $ne: 'REVOKED' } },
    { $set: { status: input.status, updatedAt: now }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  if (!updated) {
    throw conflict('This member changed since you loaded the page. Refresh and try again.', 'STALE_VERSION');
  }
  if (input.status === 'SUSPENDED') {
    await db.c.assignments.updateMany(
      { memberId, organizationId: membership.organizationId, effectiveTo: null },
      { $set: { effectiveTo: now, endedBy: auth.user.id } },
    );
    await db.c.sites.updateMany(
      { teamLeadId: memberId, organizationId: membership.organizationId },
      { $set: { teamLeadId: null, updatedAt: now } },
    );
    await db.c.sites.updateMany(
      { inspectorId: memberId, organizationId: membership.organizationId },
      { $set: { inspectorId: null, updatedAt: now } },
    );
  }
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: input.status === 'SUSPENDED' ? 'member.suspended' : 'member.reactivated',
    targetType: 'member',
    targetId: memberId,
    organizationId: membership.organizationId,
    siteId: null,
    requestId,
    summary:
      input.status === 'SUSPENDED'
        ? `Suspended a team member. Reason: ${input.reason}`
        : `Reactivated a team member. Reason: ${input.reason}`,
    meta: {
      reason: input.reason,
      previousStatus: membership.status,
      membershipId: membership._id.toHexString(),
    },
  });
  return teamMemberDetail(db, auth, memberId);
}

/**
 * Owners can remove a staff member from their whole team.
 *
 * By default this is a revocation: the account and attendance history remain,
 * but every membership and assignment in the owner's organization ends
 * immediately. When the owner asks for a permanent removal the person is
 * deleted from the database outright, together with their login, sessions,
 * assignments, and the attendance rows that only they owned.
 */
export async function removeTeamMember(
  db: Database,
  auth: AuthContext,
  memberId: string,
  input: MemberRemoval,
  requestId: string,
): Promise<MemberRemovalSummary> {
  const membership = await ownedMembership(db, auth, memberId);
  if (membership.userId === auth.user.id) {
    throw conflict('You cannot remove yourself from the team here.');
  }
  if (membership.version !== input.expectedVersion) {
    throw conflict('This member changed since you loaded the page. Refresh and try again.', 'STALE_VERSION');
  }
  const working = await db.c.shifts.countDocuments({ userId: memberId, status: 'WORKING' });
  if (working > 0) {
    throw conflict('This member is still clocked in. End the shift before removing them.');
  }

  if (input.permanent) {
    const result = await purgeStaffMember(db, {
      userId: memberId,
      actorId: auth.user.id,
      actorName: auth.user.name,
      actorRole: auth.roles[0] ?? null,
      organizationId: membership.organizationId,
      reason: input.reason,
      requestId,
    });
    const purgedRecords =
      result.usersDeleted +
      result.sessionsDeleted +
      result.accountsDeleted +
      result.twoFactorDeleted +
      result.membershipsDeleted +
      result.assignmentsDeleted +
      result.shiftsDeleted +
      result.attendanceEventsDeleted +
      result.observationsDeleted +
      result.incidentsDeleted +
      result.correctionsDeleted +
      result.alertsDeleted +
      result.devicesDeleted +
      result.accessGrantsDeleted;
    return {
      id: memberId,
      organizationId: membership.organizationId.toHexString(),
      membershipsRevoked: result.membershipsDeleted,
      assignmentsEnded: result.assignmentsDeleted,
      invitationsRevoked: result.invitationsDeleted,
      sitesCleared: result.sitesCleared,
      permanent: true,
      purgedRecords,
      purgedUserIds: result.purgedUserIds,
    };
  }

  const user = (await usersByIds(db.c, [memberId])).get(memberId);
  const now = new Date();
  const counts = {
    membershipsRevoked: 0,
    assignmentsEnded: 0,
    invitationsRevoked: 0,
    sitesCleared: 0,
  };

  await withTransaction(db, async (session) => {
    const removed = await db.c.memberships.findOneAndUpdate(
      {
        _id: membership._id,
        version: input.expectedVersion,
        status: { $ne: 'REVOKED' },
      },
      { $set: { status: 'REVOKED', updatedAt: now }, $inc: { version: 1 } },
      { session, returnDocument: 'after' },
    );
    if (!removed) {
      throw conflict('This member changed while they were being removed.', 'STALE_VERSION');
    }
    counts.membershipsRevoked = 1;
    counts.assignmentsEnded = (
      await db.c.assignments.updateMany(
        { memberId, organizationId: membership.organizationId, effectiveTo: null },
        { $set: { effectiveTo: now, endedBy: auth.user.id } },
        { session },
      )
    ).modifiedCount;
    counts.sitesCleared = (
      await db.c.sites.updateMany(
        {
          organizationId: membership.organizationId,
          $or: [{ teamLeadId: memberId }, { inspectorId: memberId }],
        },
        { $set: { teamLeadId: null, inspectorId: null, updatedAt: now } },
        { session },
      )
    ).modifiedCount;
    if (user?.email) {
      counts.invitationsRevoked = (
        await db.c.invitations.updateMany(
          { organizationId: membership.organizationId, email: user.email, status: 'PENDING' },
          { $set: { status: 'REVOKED' } },
          { session },
        )
      ).modifiedCount;
    }
  });

  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'member.removed',
    targetType: 'member',
    targetId: memberId,
    organizationId: membership.organizationId,
    siteId: null,
    requestId,
    summary: `Removed a team member. Reason: ${input.reason}`,
    meta: { reason: input.reason, membershipId: membership._id.toHexString(), ...counts },
  });
  return { id: memberId, organizationId: membership.organizationId.toHexString(), ...counts };
}

export async function queryTeamMember(
  db: Database,
  auth: AuthContext,
  memberId: string,
  input: MemberQueryInput,
  requestId: string,
): Promise<TeamMemberDetail['queries'][number]> {
  const membership = await ownedMembership(db, auth, memberId);
  let siteId: ObjectId | null = null;
  if (input.siteId) {
    const site = await db.c.sites.findOne({
      _id: new ObjectId(input.siteId),
      organizationId: membership.organizationId,
      deletedAt: null,
    });
    if (!site) throw notFound('Site not found.');
    siteId = site._id;
  }
  const audit = await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'member.queried',
    targetType: 'member',
    targetId: memberId,
    organizationId: membership.organizationId,
    siteId,
    requestId,
    summary: input.message,
    meta: { message: input.message, membershipId: membership._id.toHexString() },
  });
  return {
    id: audit.id,
    at: new Date().toISOString(),
    message: input.message,
    byName: auth.user.name,
  };
}

export async function updateStaffProfile(db: Database, auth: AuthContext, memberId: string,
  input: import('../contracts/accounts.js').StaffProfileUpdate, requestId: string) {
  const membership = await ownedMembership(db, auth, memberId);
  if (memberId === auth.user.id) throw forbidden('You cannot change your own role here.');
  await withTransaction(db, async (session) => {
    const changed = await db.c.memberships.updateOne({ _id: membership._id, version: input.expectedVersion }, {
      $set: { role: input.role, canUpdateSiteLocation: input.role === 'SUPERVISOR' && input.canUpdateSiteLocation, updatedAt: new Date() },
      $inc: { version: 1 },
    }, { session });
    if (!changed.matchedCount) throw conflict('Refresh this member and try again.', 'STALE_VERSION');
    const user = (await usersByIds(db.c, [memberId])).get(memberId);
    if (!user) throw notFound('Member not found.');
    const changedEmail = input.email !== undefined && input.email !== user.email;
    if (changedEmail && await db.c.users.findOne({ email: input.email }, { session })) throw conflict('Email is already in use.');
    await db.c.users.updateOne({ _id: user._id }, { $set: { name: input.name, phone: input.phone, updatedAt: new Date(), ...(changedEmail ? { email: input.email!, emailVerified: false } : {}) } }, { session });
    if (changedEmail) await db.db.collection('session').deleteMany({ userId: memberId }, { session });
  });
  await appendAudit(db.c, { actorId: auth.user.id, actorName: auth.user.name, actorRole: auth.roles[0] ?? null,
    action: 'member.updated', targetType: 'member', targetId: memberId, organizationId: membership.organizationId,
    siteId: null, requestId, summary: 'Updated staff profile and supervisor permissions.',
    meta: { role: input.role, canUpdateSiteLocation: input.canUpdateSiteLocation } });
  return teamMemberDetail(db, auth, memberId);
}
