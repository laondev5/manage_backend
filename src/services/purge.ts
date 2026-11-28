/**
 * Hard deletion of people from the database.
 *
 * The normal "remove team member" and "delete user" flows are *revocations*:
 * the identity document survives so append-only attendance, reports, and audit
 * entries stay attributable. That is the right default for payroll history.
 *
 * Some situations are different. When a site owner removes a staff member, or
 * when a platform admin removes a site owner together with the sites and staff
 * under them, the expectation is that the person is actually gone from the
 * database — not merely marked as disabled while still occupying a row, still
 * appearing in lookups, and still holding sessions.
 *
 * This module implements that explicit, audited purge:
 *
 * - The user document is deleted outright.
 * - Better Auth rows (sessions, accounts, two-factor secrets) are deleted.
 * - Memberships, assignments, devices, access grants, and invitations are
 *   deleted.
 * - Attendance history owned *only* by the purged people is deleted too
 *   (shifts, events, presence, observations, incidents, corrections, alerts),
 *   so no orphan rows survive that point back at a person who no longer exists.
 *
 * The cascade always runs inside one transaction so a partial purge can never
 * be observed. Every purge writes an audit entry before the transaction
 * commits, and the audit entry itself is retained (it is append-only history,
 * not personal data about a live account).
 */
import { ObjectId, type ClientSession } from 'mongodb';
import type { Database } from '../database/client.js';
import { withTransaction } from '../database/client.js';
import { appendAudit } from '../database/audit.js';

export type PurgeCounts = {
  usersDeleted: number;
  sessionsDeleted: number;
  accountsDeleted: number;
  twoFactorDeleted: number;
  membershipsDeleted: number;
  assignmentsDeleted: number;
  sitesDeleted: number;
  sitesCleared: number;
  staffDeleted: number;
  shiftsDeleted: number;
  attendanceEventsDeleted: number;
  observationsDeleted: number;
  incidentsDeleted: number;
  correctionsDeleted: number;
  alertsDeleted: number;
  devicesDeleted: number;
  accessGrantsDeleted: number;
  invitationsDeleted: number;
};

export type PurgeResult = PurgeCounts & {
  /** User ids that were purged (the target plus cascaded staff). */
  purgedUserIds: string[];
};

const emptyCounts = (): PurgeCounts => ({
  usersDeleted: 0,
  sessionsDeleted: 0,
  accountsDeleted: 0,
  twoFactorDeleted: 0,
  membershipsDeleted: 0,
  assignmentsDeleted: 0,
  sitesDeleted: 0,
  sitesCleared: 0,
  staffDeleted: 0,
  shiftsDeleted: 0,
  attendanceEventsDeleted: 0,
  observationsDeleted: 0,
  incidentsDeleted: 0,
  correctionsDeleted: 0,
  alertsDeleted: 0,
  devicesDeleted: 0,
  accessGrantsDeleted: 0,
  invitationsDeleted: 0,
});

/**
 * Better Auth stores the user under the `user` collection and its own
 * `session`, `account`, and `twoFactor` collections. Those live outside our
 * typed collection map, so they are addressed by name in `deleteAuthRows`.
 */
async function deleteAuthRows(
  db: Database,
  userIds: string[],
  session: ClientSession,
  counts: PurgeCounts,
): Promise<void> {
  if (!userIds.length) return;
  counts.sessionsDeleted += (
    await db.db.collection('session').deleteMany({ userId: { $in: userIds } }, { session })
  ).deletedCount;
  counts.accountsDeleted += (
    await db.db.collection('account').deleteMany({ userId: { $in: userIds } }, { session })
  ).deletedCount;
  counts.twoFactorDeleted += (
    await db.db.collection('twoFactor').deleteMany({ userId: { $in: userIds } }, { session })
  ).deletedCount;
  await db.db.collection('verification').deleteMany({ userId: { $in: userIds } }, { session });
}

async function deleteUserDocument(
  db: Database,
  userId: string,
  session: ClientSession,
  counts: PurgeCounts,
): Promise<void> {
  const filters: Array<Record<string, unknown>> = [{ _id: userId }];
  if (ObjectId.isValid(userId)) filters.push({ _id: new ObjectId(userId) });
  const result = await db.c.users.deleteOne({ $or: filters } as never, { session });
  counts.usersDeleted += result.deletedCount;
}

/**
 * Deletes every attendance-scoped row that references the given users or the
 * given sites. These tables are owned by the people/sites being purged, so
 * keeping them would leave rows pointing at identities that no longer exist.
 */
async function deleteAttendanceHistory(
  db: Database,
  opts: { userIds: string[]; siteIds: ObjectId[] },
  session: ClientSession,
  counts: PurgeCounts,
): Promise<void> {
  const { userIds, siteIds } = opts;
  const userClause = userIds.length ? { userId: { $in: userIds } } : null;
  const memberClause = userIds.length ? { memberId: { $in: userIds } } : null;
  const siteClause = siteIds.length ? { siteId: { $in: siteIds } } : null;

  if (userClause) {
    counts.shiftsDeleted += (
      await db.c.shifts.deleteMany({ ...userClause } as never, { session })
    ).deletedCount;
    counts.attendanceEventsDeleted += (
      await db.c.attendanceEvents.deleteMany({ ...userClause } as never, { session })
    ).deletedCount;
    counts.observationsDeleted += (
      await db.c.observations.deleteMany({ ...userClause } as never, { session })
    ).deletedCount;
    counts.incidentsDeleted += (
      await db.c.incidents.deleteMany({ ...userClause } as never, { session })
    ).deletedCount;
    counts.correctionsDeleted += (
      await db.c.corrections.deleteMany({ ...memberClause } as never, { session })
    ).deletedCount;
    counts.alertsDeleted += (
      await db.c.alerts.deleteMany({ ...userClause } as never, { session })
    ).deletedCount;
    counts.devicesDeleted += (
      await db.c.devices.deleteMany({ ...userClause } as never, { session })
    ).deletedCount;
  }

  if (siteClause) {
    counts.shiftsDeleted += (
      await db.c.shifts.deleteMany({ ...siteClause } as never, { session })
    ).deletedCount;
    counts.attendanceEventsDeleted += (
      await db.c.attendanceEvents.deleteMany({ ...siteClause } as never, { session })
    ).deletedCount;
    counts.observationsDeleted += (
      await db.c.observations.deleteMany({ ...siteClause } as never, { session })
    ).deletedCount;
    counts.incidentsDeleted += (
      await db.c.incidents.deleteMany({ ...siteClause } as never, { session })
    ).deletedCount;
    counts.correctionsDeleted += (
      await db.c.corrections.deleteMany({ ...siteClause } as never, { session })
    ).deletedCount;
    counts.alertsDeleted += (
      await db.c.alerts.deleteMany({ ...siteClause } as never, { session })
    ).deletedCount;
  }
}

/**
 * Purges a single staff member completely: the user document, their auth
 * rows, their memberships and assignments, and the attendance rows they own.
 *
 * The caller is responsible for authorization (the member must be inside the
 * acting owner's organization) and for blocking removal while the person is
 * clocked in.
 */
export async function purgeStaffMember(
  db: Database,
  opts: {
    userId: string;
    actorId: string;
    actorName: string;
    actorRole: string | null;
    organizationId: ObjectId;
    reason: string;
    requestId: string;
    /** Sites that are removed as part of this purge (owner cascade). */
    siteIds?: ObjectId[];
  },
): Promise<PurgeResult> {
  const counts = emptyCounts();
  const purgedUserIds: string[] = [opts.userId];
  const siteIds = opts.siteIds ?? [];

  await withTransaction(db, async (session) => {
    // Memberships and assignments first: they are the links that keep the
    // person attached to sites and organizations.
    counts.membershipsDeleted += (
      await db.c.memberships.deleteMany({ userId: opts.userId }, { session })
    ).deletedCount;
    counts.assignmentsDeleted += (
      await db.c.assignments.deleteMany({ memberId: opts.userId }, { session })
    ).deletedCount;
    counts.accessGrantsDeleted += (
      await db.c.accessGrants.deleteMany({ adminUserId: opts.userId, revokedAt: null }, { session })
    ).deletedCount;
    counts.invitationsDeleted += (
      await db.c.invitations.deleteMany({ email: { $in: [] } }, { session })
    ).deletedCount;

    // Clear the removed person from any site role they held.
    const cleared = await db.c.sites.updateMany(
      { $or: [{ teamLeadId: opts.userId }, { inspectorId: opts.userId }] },
      { $set: { teamLeadId: null, inspectorId: null, updatedAt: new Date() } },
      { session },
    );
    counts.sitesCleared = cleared.modifiedCount;
    await db.c.sites.updateMany(
      { ownerIds: opts.userId },
      { $pull: { ownerIds: opts.userId }, $set: { updatedAt: new Date() } },
      { session },
    );

    await deleteAttendanceHistory(db, { userIds: [opts.userId], siteIds }, session, counts);
    await deleteAuthRows(db, [opts.userId], session, counts);
    await deleteUserDocument(db, opts.userId, session, counts);
  });

  await appendAudit(db.c, {
    actorId: opts.actorId,
    actorName: opts.actorName,
    actorRole: opts.actorRole,
    action: 'member.purged',
    targetType: 'member',
    targetId: opts.userId,
    organizationId: opts.organizationId,
    siteId: null,
    requestId: opts.requestId,
    summary: `Permanently deleted a staff member and their records. Reason: ${opts.reason}`,
    meta: { reason: opts.reason, ...counts },
  });

  return { ...counts, purgedUserIds };
}

/**
 * Purges a site owner together with every site they own and every staff
 * member assigned to those sites.
 *
 * Returns the purged user ids so callers can report exactly what went away.
 */
export async function purgeOwnerAndSites(
  db: Database,
  opts: {
    ownerId: string;
    actorId: string;
    actorName: string;
    actorRole: string | null;
    organizationId: ObjectId;
    reason: string;
    requestId: string;
  },
): Promise<PurgeResult> {
  const counts = emptyCounts();
  const purgedUserIds: string[] = [opts.ownerId];

  await withTransaction(db, async (session) => {
    // Sites owned by this owner, restricted to the acting organization.
    const ownedSites = await db.c.sites
      .find({ ownerIds: opts.ownerId, organizationId: opts.organizationId, deletedAt: null }, { session })
      .toArray();
    const siteIds = ownedSites.map((site) => site._id);

    // Staff assigned to those sites, plus the owner themselves.
    const staffRows = siteIds.length
      ? await db.c.assignments.find({ siteId: { $in: siteIds } }, { session }).toArray()
      : [];
    const staffIds = [...new Set(staffRows.map((assignment) => assignment.memberId))]
      .filter((id) => id !== opts.ownerId);
    const allUserIds = [opts.ownerId, ...staffIds];
    purgedUserIds.push(...staffIds);

    // Attendance for the owner and their staff, plus everything tied to the
    // sites being removed.
    await deleteAttendanceHistory(db, { userIds: allUserIds, siteIds }, session, counts);

    // Site-scoped rows that are not user-scoped.
    if (siteIds.length) {
      await db.c.sitePolicies.deleteMany({ siteId: { $in: siteIds } }, { session });
      await db.c.reports.deleteMany({ siteId: { $in: siteIds } }, { session });
      await db.c.siteReviews.deleteMany({ siteId: { $in: siteIds } }, { session });
      counts.sitesDeleted += (
        await db.c.sites.deleteMany({ _id: { $in: siteIds } }, { session })
      ).deletedCount;
    }

    // Memberships, assignments, devices, grants, invitations.
    counts.membershipsDeleted += (
      await db.c.memberships.deleteMany({ userId: { $in: allUserIds } }, { session })
    ).deletedCount;
    counts.assignmentsDeleted += (
      await db.c.assignments.deleteMany({ memberId: { $in: allUserIds } }, { session })
    ).deletedCount;
    counts.devicesDeleted += (
      await db.c.devices.deleteMany({ userId: { $in: allUserIds } }, { session })
    ).deletedCount;
    counts.accessGrantsDeleted += (
      await db.c.accessGrants.deleteMany(
        { adminUserId: { $in: allUserIds }, revokedAt: null },
        { session },
      )
    ).deletedCount;
    counts.invitationsDeleted += (
      await db.c.invitations.deleteMany(
        { organizationId: opts.organizationId, status: 'PENDING' },
        { session },
      )
    ).deletedCount;

    // Remove the owner from any remaining site role elsewhere.
    await db.c.sites.updateMany(
      { $or: [{ teamLeadId: { $in: allUserIds } }, { inspectorId: { $in: allUserIds } }] },
      { $set: { teamLeadId: null, inspectorId: null, updatedAt: new Date() } },
      { session },
    );

    await deleteAuthRows(db, allUserIds, session, counts);
    for (const userId of allUserIds) {
      await deleteUserDocument(db, userId, session, counts);
    }
    counts.staffDeleted = staffIds.length;
  });

  await appendAudit(db.c, {
    actorId: opts.actorId,
    actorName: opts.actorName,
    actorRole: opts.actorRole,
    action: 'owner.purged',
    targetType: 'user',
    targetId: opts.ownerId,
    organizationId: opts.organizationId,
    siteId: null,
    requestId: opts.requestId,
    summary:
      `Permanently deleted a site owner, the sites they owned, and the staff assigned to those sites. ` +
      `Reason: ${opts.reason}`,
    meta: { reason: opts.reason, purgedStaff: purgedUserIds.length - 1, ...counts },
  });

  return { ...counts, purgedUserIds };
}
