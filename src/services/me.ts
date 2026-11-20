import { ObjectId } from 'mongodb';
import {
  AppError,
  forbidden,
  notFound,
  type MeResponse,
  type OnboardingState,
} from '../contracts/index.js';
import { updateOnboardingStep, type Database } from '../database/index.js';
import type { AuthContext } from '../http/context.js';

const STAFF_STEPS = ['detailsConfirmed', 'siteReviewed', 'readinessCompleted'] as const;
const OWNER_STEPS = ['siteDetailsDone', 'boundaryDone', 'inviteDone', 'alertsReviewed'] as const;

export function meResponse(auth: AuthContext): MeResponse {
  return {
    mustChangePassword: auth.context.user.mustChangePassword === true,
    user: {
      id: auth.user.id,
      name: auth.user.name,
      email: auth.user.email,
      emailVerified: auth.user.emailVerified,
      twoFactorEnabled: auth.user.twoFactorEnabled,
    },
    memberships: auth.context.memberships.map((entry) => ({
      organizationId: entry.organization._id.toHexString(),
      organizationName: entry.organization.name,
      role: entry.membership.role,
      status: entry.membership.status,
    })),
    activeOrganizationId: auth.activeOrganizationId,
    capabilities: auth.capabilities,
    assignedSiteIds: auth.actor.assignedSiteIds,
    mfaSetupRequired: auth.mfaSetupRequired,
  };
}

export async function switchOrganization(
  db: Database,
  auth: AuthContext,
  organizationId: string,
): Promise<{ ok: true }> {
  const membership = await db.c.memberships.findOne({
    organizationId: new ObjectId(organizationId),
    userId: auth.user.id,
    status: 'ACTIVE',
  });
  if (!membership) throw notFound('Organization not found.');
  const organization = await db.c.organizations.findOne({
    _id: membership.organizationId,
    status: 'ACTIVE',
  });
  if (!organization) throw notFound('Organization not found.');
  return { ok: true };
}

async function activeMembership(db: Database, auth: AuthContext) {
  if (auth.activeOrganizationId) {
    const membership = await db.c.memberships.findOne({
      organizationId: new ObjectId(auth.activeOrganizationId),
      userId: auth.user.id,
      status: 'ACTIVE',
    });
    if (membership) return membership;
  }
  return db.c.memberships.findOne({ userId: auth.user.id, status: 'ACTIVE' });
}

export async function onboardingState(
  db: Database,
  auth: AuthContext,
): Promise<OnboardingState> {
  const membership = await activeMembership(db, auth);
  const staffFlags = membership && ['STAFF', 'SUPERVISOR'].includes(membership.role) ? membership.onboarding : null;
  const ownerFlags =
    membership?.role === 'SITE_OWNER' || membership?.role === 'PLATFORM_ADMIN'
      ? membership.onboarding
      : null;
  return {
    staff: {
      detailsConfirmed: staffFlags?.detailsConfirmed ?? false,
      siteReviewed: staffFlags?.siteReviewed ?? false,
      readinessCompleted: staffFlags?.readinessCompleted ?? false,
      completedAt: staffFlags?.completedAt?.toISOString() ?? null,
    },
    owner: {
      siteDetailsDone: ownerFlags?.siteDetailsDone ?? false,
      boundaryDone: ownerFlags?.boundaryDone ?? false,
      inviteDone: ownerFlags?.inviteDone ?? false,
      alertsReviewed: ownerFlags?.alertsReviewed ?? false,
      completedAt: ownerFlags?.completedAt?.toISOString() ?? null,
    },
  };
}

export async function updateOnboarding(
  db: Database,
  auth: AuthContext,
  input: { step: string; value: boolean },
): Promise<OnboardingState> {
  if (!auth.activeOrganizationId) throw forbidden('Choose an organization first.');
  const membership = await activeMembership(db, auth);
  if (!membership) throw notFound('Membership not found.');
  const staffStep = (STAFF_STEPS as readonly string[]).includes(input.step);
  const ownerStep = (OWNER_STEPS as readonly string[]).includes(input.step);
  if (!staffStep && !ownerStep) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Unknown onboarding step.');
  }
  if (staffStep && !['STAFF', 'SUPERVISOR'].includes(membership.role)) {
    throw forbidden('This onboarding step is for staff accounts.');
  }
  if (ownerStep && ['STAFF', 'SUPERVISOR'].includes(membership.role)) {
    throw forbidden('This onboarding step is for site owners.');
  }
  await updateOnboardingStep(db.c, {
    organizationId: membership.organizationId,
    userId: auth.user.id,
    step: input.step as
      | 'detailsConfirmed'
      | 'siteReviewed'
      | 'readinessCompleted'
      | 'siteDetailsDone'
      | 'boundaryDone'
      | 'inviteDone'
      | 'alertsReviewed',
    value: input.value,
  });
  return onboardingState(db, auth);
}
