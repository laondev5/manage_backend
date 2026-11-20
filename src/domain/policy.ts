import type { Capability, MembershipSummary, Role } from '../contracts/index.js';

const STAFF_CAPABILITIES: Capability[] = ['staff.today', 'staff.history', 'staff.clock'];
const OWNER_CAPABILITIES: Capability[] = [
  'owner.overview',
  'owner.sites',
  'owner.alerts',
  'owner.team',
  'owner.corrections',
  'owner.reports',
  'owner.exports',
];
const ADMIN_CAPABILITIES: Capability[] = [
  'admin.organizations',
  'admin.users',
  'admin.sites',
  'admin.audit',
  'admin.health',
];

export const roleCapabilities = (role: Role): Capability[] => {
  switch (role) {
    case 'SUPERVISOR':
    case 'STAFF':
      return [...STAFF_CAPABILITIES];
    case 'SITE_OWNER':
      return [...OWNER_CAPABILITIES];
    case 'PLATFORM_ADMIN':
      return [...ADMIN_CAPABILITIES];
  }
};

export function capabilitiesFor(
  memberships: Array<Pick<MembershipSummary, 'role' | 'status'>>,
  extra: Capability[] = [],
): Capability[] {
  const result = new Set<Capability>(extra);
  for (const membership of memberships) {
    if (membership.status !== 'ACTIVE') continue;
    for (const capability of roleCapabilities(membership.role)) result.add(capability);
  }
  return [...result];
}

export const hasCapability = (capabilities: Capability[], capability: Capability) =>
  capabilities.includes(capability);

export const isOwnerRole = (role: Role) => role === 'SITE_OWNER' || role === 'PLATFORM_ADMIN';

export const requiresMfa = (roles: Role[]) =>
  roles.some((role) => role === 'SITE_OWNER' || role === 'PLATFORM_ADMIN');

export type ScopedActor = {
  userId: string;
  capabilities: Capability[];
  organizationIds: string[];
  ownedOrganizationIds: string[];
  staffOrganizationIds: string[];
  adminOrganizationIds: string[];
  ownedSiteIds: string[];
  assignedSiteIds: string[];
};

export function canReadSite(actor: ScopedActor, site: { organizationId: string; id: string }) {
  return (
    actor.capabilities.includes('admin.sites') ||
    actor.ownedSiteIds.includes(site.id) ||
    actor.adminOrganizationIds.includes(site.organizationId) ||
    actor.assignedSiteIds.includes(site.id)
  );
}

export function canManageSite(actor: ScopedActor, site: { organizationId: string; id: string }) {
  if (actor.capabilities.includes('admin.sites') || actor.ownedSiteIds.includes(site.id)) return true;
  return (
    actor.adminOrganizationIds.includes(site.organizationId) &&
    actor.capabilities.includes('admin.sites')
  );
}

export function canClockIn(actor: ScopedActor, siteId: string) {
  return actor.assignedSiteIds.includes(siteId) && actor.capabilities.includes('staff.clock');
}

export function canUpdateSupervisorLocation(input: {
  role: Role; active: boolean; permitted: boolean; assigned: boolean;
}, changedFields: string[]) {
  return input.role === 'SUPERVISOR' && input.active && input.permitted && input.assigned &&
    changedFields.every((key) => ['latitude', 'longitude', 'version'].includes(key));
}

export function canReviewCorrections(
  actor: ScopedActor,
  site: { organizationId: string; id: string },
): boolean {
  return (
    actor.ownedSiteIds.includes(site.id) &&
    actor.capabilities.includes('owner.corrections')
  );
}

export function canViewOperationalAttendance(actor: ScopedActor, organizationId: string) {
  return (
    actor.capabilities.includes('admin.attendance_read') &&
    actor.adminOrganizationIds.includes(organizationId)
  );
}

export function canViewExactLocation(actor: ScopedActor, organizationId: string) {
  return (
    actor.capabilities.includes('admin.location_read') &&
    actor.adminOrganizationIds.includes(organizationId)
  );
}
