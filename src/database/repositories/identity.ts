import { ObjectId, type ClientSession } from 'mongodb';
import { notFound } from '../../contracts/index.js';
import type {
  AccessGrantDoc,
  AuthUserDoc,
  Collections,
  MembershipDoc,
  OrganizationDoc,
  SiteDoc,
} from '../collections.js';
import { userIdOf } from '../collections.js';

export type MembershipWithOrganization = {
  membership: MembershipDoc;
  organization: OrganizationDoc;
};

export type UserContextRecord = {
  user: AuthUserDoc;
  userId: string;
  memberships: MembershipWithOrganization[];
  assignedSites: Array<{ site: SiteDoc; membership: MembershipDoc }>;
  ownedSites: SiteDoc[];
  grants: AccessGrantDoc[];
};

const isActiveAssignment = (now: Date) => ({
  effectiveFrom: { $lte: now },
  $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }],
});

export async function getUserContext(
  c: Collections,
  userId: string,
  now = new Date(),
): Promise<UserContextRecord> {
  const idFilters: Array<Record<string, unknown>> = [{ _id: userId }];
  if (ObjectId.isValid(userId)) idFilters.push({ _id: new ObjectId(userId) });
  const user = await c.users.findOne({ $or: idFilters });
  if (!user) throw notFound('Your account record could not be found.');

  const memberships = await c.memberships
    .find({ userId, status: { $in: ['ACTIVE', 'SUSPENDED'] } })
    .toArray();
  const organizationIds = memberships.map((membership) => membership.organizationId);
  const organizations = organizationIds.length
    ? await c.organizations.find({ _id: { $in: organizationIds } }).toArray()
    : [];
  const orgById = new Map(organizations.map((org) => [org._id.toHexString(), org]));
  const membershipByOrg = new Map(
    memberships.map((membership) => [membership.organizationId.toHexString(), membership]),
  );
  const withOrgs = memberships
    .map((membership) => {
      const organization = orgById.get(membership.organizationId.toHexString());
      return organization ? { membership, organization } : null;
    })
    .filter((entry): entry is MembershipWithOrganization => entry !== null);

  const assignments = await c.assignments
    .find({ memberId: userId, ...isActiveAssignment(now) })
    .sort({ effectiveFrom: -1 })
    .toArray();
  const assignedSiteIds = [...new Set(assignments.map((assignment) => assignment.siteId.toHexString()))];
  const assignedSites = assignedSiteIds.length
    ? await c.sites.find({ _id: { $in: assignedSiteIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const assigned = assignedSites
    .map((site) => {
      const membership = membershipByOrg.get(site.organizationId.toHexString());
      if (!membership || membership.status !== 'ACTIVE') return null;
      return { site, membership };
    })
    .filter((entry): entry is { site: SiteDoc; membership: MembershipDoc } => entry !== null);

  const ownedSiteCandidates = await c.sites.find({ ownerIds: userId }).toArray();
  const ownedSites = ownedSiteCandidates.filter((site) => {
    const membership = membershipByOrg.get(site.organizationId.toHexString());
    const organization = orgById.get(site.organizationId.toHexString());
    return (
      membership?.status === 'ACTIVE' &&
      (membership.role === 'SITE_OWNER' || membership.role === 'PLATFORM_ADMIN') &&
      organization?.status === 'ACTIVE'
    );
  });

  const grants = await c.accessGrants
    .find({
      adminUserId: userId,
      revokedAt: null,
      expiresAt: { $gt: now },
    })
    .toArray();

  return {
    user,
    userId: userIdOf(user),
    memberships: withOrgs,
    assignedSites: assigned,
    ownedSites,
    grants,
  };
}

export async function createMembership(
  c: Collections,
  input: {
    organizationId: ObjectId;
    userId: string;
    role: MembershipDoc['role'];
    title?: string | null;
  },
  session?: ClientSession,
): Promise<MembershipDoc> {
  const now = new Date();
  const membership: MembershipDoc = {
    _id: new ObjectId(),
    organizationId: input.organizationId,
    userId: input.userId,
    role: input.role,
    status: 'ACTIVE',
    title: input.title ?? null,
    onboarding: {
      detailsConfirmed: false,
      siteReviewed: false,
      readinessCompleted: false,
      siteDetailsDone: false,
      boundaryDone: false,
      inviteDone: false,
      alertsReviewed: false,
      completedAt: null,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await c.memberships.insertOne(membership, { session });
  return membership;
}

export type OnboardingStep =
  | 'detailsConfirmed'
  | 'siteReviewed'
  | 'readinessCompleted'
  | 'siteDetailsDone'
  | 'boundaryDone'
  | 'inviteDone'
  | 'alertsReviewed';

export async function updateOnboardingStep(
  c: Collections,
  input: {
    organizationId: ObjectId;
    userId: string;
    step: OnboardingStep;
    value: boolean;
  },
): Promise<void> {
  const membership = await c.memberships.findOne({
    organizationId: input.organizationId,
    userId: input.userId,
    status: 'ACTIVE',
  });
  if (!membership) throw notFound('Membership not found.');
  const staffSteps: OnboardingStep[] = ['detailsConfirmed', 'siteReviewed', 'readinessCompleted'];
  const ownerSteps: OnboardingStep[] = ['siteDetailsDone', 'boundaryDone', 'inviteDone', 'alertsReviewed'];
  const relevant = ['STAFF', 'SUPERVISOR'].includes(membership.role) ? staffSteps : ownerSteps;
  const merged = { ...membership.onboarding, [input.step]: input.value };
  const complete = relevant.every((step) => merged[step]);
  await c.memberships.updateOne(
    { _id: membership._id },
    {
      $set: {
        [`onboarding.${input.step}`]: input.value,
        'onboarding.completedAt': complete ? (membership.onboarding.completedAt ?? new Date()) : null,
        updatedAt: new Date(),
      },
    },
  );
}

export async function findActiveMembership(
  c: Collections,
  organizationId: ObjectId,
  userId: string,
) {
  return c.memberships.findOne({ organizationId, userId, status: 'ACTIVE' });
}

export async function usersByIds(c: Collections, ids: string[]) {
  if (!ids.length) return new Map<string, AuthUserDoc>();
  const values: Array<string | ObjectId> = [];
  for (const id of ids) {
    values.push(id);
    if (ObjectId.isValid(id)) values.push(new ObjectId(id));
  }
  const users = await c.users.find({ _id: { $in: values } }).toArray();
  return new Map(users.map((user) => [userIdOf(user), user]));
}

export async function listAdminUsers(c: Collections, limit = 200) {
  const users = await c.users.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
  const userIds = users.map((user) => userIdOf(user));
  const memberships = userIds.length
    ? await c.memberships.find({ userId: { $in: userIds } }).toArray()
    : [];
  const orgIds = [...new Set(memberships.map((membership) => membership.organizationId.toHexString()))];
  const organizations = orgIds.length
    ? await c.organizations.find({ _id: { $in: orgIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const orgById = new Map(organizations.map((org) => [org._id.toHexString(), org]));
  return users.map((user) => {
    const id = userIdOf(user);
    return {
      user,
      userId: id,
      memberships: memberships
        .filter((membership) => membership.userId === id)
        .map((membership) => ({
          membership,
          organization: orgById.get(membership.organizationId.toHexString()) ?? null,
        })),
    };
  });
}

export async function updateMembership(
  c: Collections,
  membershipId: ObjectId,
  changes: { status?: MembershipDoc['status']; role?: MembershipDoc['role'] },
): Promise<MembershipDoc | null> {
  const result = await c.memberships.findOneAndUpdate(
    { _id: membershipId },
    { $set: { ...changes, updatedAt: new Date() }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  return result;
}
