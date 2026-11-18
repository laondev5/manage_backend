import { ObjectId, type ClientSession } from 'mongodb';
import type { SitePolicy } from '../../contracts/index.js';
import type {
  AssignmentDoc,
  Collections,
  GeoPointDoc,
  InvitationDoc,
  MembershipDoc,
  ShiftDoc,
  SiteDoc,
  SitePolicyHistoryDoc,
} from '../collections.js';
import { pointDoc } from '../collections.js';

export const userIdsFilter = (ids: string[]) => {
  const values: Array<string | ObjectId> = [];
  for (const id of ids) {
    values.push(id);
    if (ObjectId.isValid(id)) values.push(new ObjectId(id));
  }
  return { $in: values };
};

export async function findSite(c: Collections, siteId: ObjectId): Promise<SiteDoc | null> {
  return c.sites.findOne({ _id: siteId });
}

export type SiteScope = {
  userId: string;
  ownedSiteIds: string[];
  assignedSiteIds: string[];
  adminOrganizationIds: string[];
  /** false (default) lists live sites; true lists archived sites that are not deleted. */
  archived?: boolean;
};

export async function listSitesScoped(c: Collections, scope: SiteScope): Promise<SiteDoc[]> {
  const filters: Record<string, unknown>[] = [{ ownerIds: scope.userId }];
  if (scope.assignedSiteIds.length) {
    filters.push({ _id: { $in: scope.assignedSiteIds.map((id) => new ObjectId(id)) } });
  }
  if (scope.adminOrganizationIds.length) {
    filters.push({
      organizationId: { $in: scope.adminOrganizationIds.map((id) => new ObjectId(id)) },
    });
  }
  return c.sites
    .find({
      $and: [
        { $or: filters },
        { deletedAt: null },
        scope.archived
          ? { $or: [{ archivedAt: { $ne: null } }, { status: 'INACTIVE' }] }
          : { archivedAt: null },
      ],
    })
    .sort({ name: 1 })
    .toArray();
}

export async function siteCounts(c: Collections, siteIds: ObjectId[], now = new Date()) {
  if (!siteIds.length) return new Map<string, { staffCount: number; onSiteCount: number }>();
  const assignments = await c.assignments
    .find({
      siteId: { $in: siteIds },
      effectiveFrom: { $lte: now },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
    })
    .toArray();
  const shifts = await c.shifts
    .find({ siteId: { $in: siteIds }, status: 'WORKING' })
    .toArray();
  const map = new Map<string, { staffCount: number; onSiteCount: number }>();
  for (const siteId of siteIds) {
    map.set(siteId.toHexString(), { staffCount: 0, onSiteCount: 0 });
  }
  for (const assignment of assignments) {
    const key = assignment.siteId.toHexString();
    const entry = map.get(key);
    if (entry) entry.staffCount += 1;
  }
  for (const shift of shifts) {
    const key = shift.siteId.toHexString();
    const entry = map.get(key);
    if (entry) entry.onSiteCount += 1;
  }
  return map;
}

export type CreateSiteInput = {
  organizationId: ObjectId;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  timezone: string;
  policy: SitePolicy;
  expectedHours: SiteDoc['expectedHours'];
  notificationPreferences: SiteDoc['notificationPreferences'];
  ownerIds: string[];
  createdBy: string;
};

export async function createSite(
  c: Collections,
  input: CreateSiteInput,
  session?: ClientSession,
): Promise<SiteDoc> {
  const now = new Date();
  const site: SiteDoc = {
    _id: new ObjectId(),
    organizationId: input.organizationId,
    name: input.name,
    address: input.address,
    location: pointDoc(input.longitude, input.latitude),
    timezone: input.timezone,
    ownerIds: input.ownerIds,
    policy: input.policy,
    policyVersion: 1,
    expectedHours: input.expectedHours,
    notificationPreferences: input.notificationPreferences,
    status: 'ACTIVE',
    teamLeadId: null,
    inspectorId: null,
    version: 1,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await c.sites.insertOne(site, { session });
  await c.sitePolicies.insertOne(
    {
      _id: new ObjectId(),
      siteId: site._id,
      organizationId: site.organizationId,
      version: 1,
      policy: input.policy,
      center: site.location,
      timezone: site.timezone,
      createdBy: input.createdBy,
      createdAt: now,
    },
    { session },
  );
  return site;
}

export type UpdateSitePatch = {
  name?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  status?: SiteDoc['status'];
  ownerIds?: string[];
  policy?: SitePolicy;
  expectedHours?: SiteDoc['expectedHours'];
  notificationPreferences?: SiteDoc['notificationPreferences'];
};

export async function updateSite(
  c: Collections,
  input: {
    site: SiteDoc;
    expectedVersion: number;
    patch: UpdateSitePatch;
    actorId: string;
  },
  session?: ClientSession,
): Promise<SiteDoc | null> {
  const policyChanged = Boolean(input.patch.policy);
  const nextVersion = policyChanged ? input.site.policyVersion + 1 : input.site.policyVersion;
  const $set: Record<string, unknown> = { updatedAt: new Date(), ...input.patch };
  if (input.patch.latitude !== undefined || input.patch.longitude !== undefined) {
    const latitude = input.patch.latitude ?? input.site.location.coordinates[1];
    const longitude = input.patch.longitude ?? input.site.location.coordinates[0];
    $set.location = pointDoc(longitude, latitude);
    delete $set.latitude;
    delete $set.longitude;
  }
  if (policyChanged) $set.policyVersion = nextVersion;
  const updated = await c.sites.findOneAndUpdate(
    { _id: input.site._id, version: input.expectedVersion },
    { $set, $inc: { version: 1 } },
    { returnDocument: 'after', session },
  );
  if (updated && policyChanged) {
    await c.sitePolicies.insertOne(
      {
        _id: new ObjectId(),
        siteId: updated._id,
        organizationId: updated.organizationId,
        version: nextVersion,
        policy: updated.policy,
        center: updated.location,
        timezone: updated.timezone,
        createdBy: input.actorId,
        createdAt: new Date(),
      },
      { session },
    );
  }
  return updated;
}

export async function getPolicyAtVersion(
  c: Collections,
  siteId: ObjectId,
  version: number,
): Promise<SitePolicyHistoryDoc | null> {
  return c.sitePolicies.findOne({ siteId, version });
}

export type RosterAssignment = {
  assignment: AssignmentDoc;
  membership: MembershipDoc | null;
  name: string;
  email: string;
  shift: ShiftDoc | null;
  lastObservationAt: Date | null;
};

export async function listRoster(
  c: Collections,
  siteId: ObjectId,
  now = new Date(),
): Promise<RosterAssignment[]> {
  const assignments = await c.assignments
    .find({
      siteId,
      effectiveFrom: { $lte: now },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
    })
    .toArray();
  const memberIds = assignments.map((assignment) => assignment.memberId);
  if (!memberIds.length) return [];
  const memberships = await c.memberships
    .find({ userId: { $in: memberIds }, status: { $ne: 'REVOKED' } })
    .toArray();
  const users = await c.users.find({ _id: userIdsFilter(memberIds) }).toArray();
  const shifts = await c.shifts
    .find({ siteId, userId: { $in: memberIds }, status: 'WORKING' })
    .toArray();
  const membershipByMember = new Map(memberships.map((m) => [m.userId, m]));
  const userByMember = new Map(
    users.map((user) => [
      typeof user._id === 'string' ? user._id : user._id.toHexString(),
      user,
    ]),
  );
  const shiftByMember = new Map(shifts.map((shift) => [shift.userId, shift]));
  return assignments.map((assignment) => {
    const user = userByMember.get(assignment.memberId);
    return {
      assignment,
      membership: membershipByMember.get(assignment.memberId) ?? null,
      name: user?.name ?? 'Unknown member',
      email: user?.email ?? '',
      shift: shiftByMember.get(assignment.memberId) ?? null,
      lastObservationAt: null,
    };
  });
}

export async function findActiveAssignment(
  c: Collections,
  siteId: ObjectId,
  memberId: string,
  now = new Date(),
) {
  return c.assignments.findOne({
    siteId,
    memberId,
    effectiveFrom: { $lte: now },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
  });
}

export async function createAssignment(
  c: Collections,
  input: {
    organizationId: ObjectId;
    siteId: ObjectId;
    memberId: string;
    membershipId: ObjectId;
    permissionScope: AssignmentDoc['permissionScope'];
    effectiveFrom?: Date;
    acceptedAt?: Date | null;
    createdBy: string;
  },
  session?: ClientSession,
): Promise<AssignmentDoc> {
  const assignment: AssignmentDoc = {
    _id: new ObjectId(),
    organizationId: input.organizationId,
    siteId: input.siteId,
    memberId: input.memberId,
    membershipId: input.membershipId,
    permissionScope: input.permissionScope,
    effectiveFrom: input.effectiveFrom ?? new Date(),
    effectiveTo: null,
    acceptedAt: input.acceptedAt ?? null,
    createdBy: input.createdBy,
    createdAt: new Date(),
  };
  await c.assignments.insertOne(assignment, { session });
  return assignment;
}

export async function acceptAssignment(
  c: Collections,
  assignmentId: ObjectId,
  memberId: string,
  now = new Date(),
): Promise<boolean> {
  const result = await c.assignments.updateOne(
    { _id: assignmentId, memberId, acceptedAt: null, effectiveTo: null },
    { $set: { acceptedAt: now } },
  );
  return result.modifiedCount === 1;
}

export async function endAssignment(
  c: Collections,
  assignmentId: ObjectId,
  actorId: string,
): Promise<boolean> {
  const result = await c.assignments.updateOne(
    { _id: assignmentId, effectiveTo: null },
    { $set: { effectiveTo: new Date(), endedBy: actorId } },
  );
  return result.modifiedCount === 1;
}

export async function createInvitation(
  c: Collections,
  input: {
    organizationId: ObjectId;
    siteId: ObjectId | null;
    email: string;
    tokenHash: string;
    note: string | null;
    createdBy: string;
    expiresAt: Date;
  },
): Promise<InvitationDoc> {
  const invitation: InvitationDoc = {
    _id: new ObjectId(),
    organizationId: input.organizationId,
    siteId: input.siteId,
    email: input.email.toLowerCase(),
    role: 'STAFF',
    tokenHash: input.tokenHash,
    status: 'PENDING',
    note: input.note,
    createdBy: input.createdBy,
    createdAt: new Date(),
    expiresAt: input.expiresAt,
    acceptedAt: null,
    acceptedBy: null,
  };
  await c.invitations.insertOne(invitation);
  return invitation;
}

export async function findInvitationByTokenHash(c: Collections, tokenHash: string) {
  return c.invitations.findOne({ tokenHash });
}

export async function markInvitationAccepted(
  c: Collections,
  invitationId: ObjectId,
  userId: string,
  session?: ClientSession,
): Promise<boolean> {
  const result = await c.invitations.updateOne(
    { _id: invitationId, status: 'PENDING' },
    { $set: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedBy: userId } },
    { session },
  );
  return result.modifiedCount === 1;
}

export async function revokeInvitation(c: Collections, invitationId: ObjectId) {
  return c.invitations.updateOne(
    { _id: invitationId, status: 'PENDING' },
    { $set: { status: 'REVOKED' } },
  );
}

export async function listInvitationsForSite(c: Collections, siteId: ObjectId) {
  return c.invitations.find({ siteId }).sort({ createdAt: -1 }).limit(100).toArray();
}

export async function listOwnerIdsForOrg(c: Collections, organizationId: ObjectId) {
  const owners = await c.memberships
    .find({ organizationId, role: 'SITE_OWNER', status: 'ACTIVE' })
    .toArray();
  return owners.map((owner) => owner.userId);
}

export async function findSitesByIds(c: Collections, ids: ObjectId[]) {
  return ids.length ? c.sites.find({ _id: { $in: ids } }).toArray() : [];
}

export function siteGeo(site: Pick<SiteDoc, 'location'>): GeoPointDoc {
  return site.location;
}
