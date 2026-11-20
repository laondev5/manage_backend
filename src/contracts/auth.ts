import { z } from 'zod';
import { objectIdSchema } from './ids.js';

export const ROLE = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  SITE_OWNER: 'SITE_OWNER',
  STAFF: 'STAFF',
  SUPERVISOR: 'SUPERVISOR',
} as const;

export const roleSchema = z.enum(['PLATFORM_ADMIN', 'SITE_OWNER', 'STAFF', 'SUPERVISOR']);
export type Role = z.infer<typeof roleSchema>;

export const membershipStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const CAPABILITIES = [
  'staff.today',
  'staff.history',
  'staff.clock',
  'owner.overview',
  'owner.sites',
  'owner.alerts',
  'owner.team',
  'owner.corrections',
  'owner.reports',
  'owner.exports',
  'admin.organizations',
  'admin.users',
  'admin.sites',
  'admin.audit',
  'admin.health',
  'admin.attendance_read',
  'admin.location_read',
  'admin.corrections_support',
  'admin.exports',
] as const;

export const capabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof capabilitySchema>;

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'Use at most 128 characters.');

export const signInFormSchema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

export const invitationAcceptSchema = z.strictObject({
  token: z.string().min(24).max(256),
  name: z.string().trim().min(2, 'Enter your full name.').max(120),
  password: passwordSchema,
});

export const invitationCreateSchema = z.strictObject({
  organizationId: objectIdSchema,
  siteId: objectIdSchema,
  email: z.email(),
  note: z.string().trim().max(300).optional(),
});

export const membershipSummarySchema = z.object({
  organizationId: z.string(),
  organizationName: z.string(),
  role: roleSchema,
  status: membershipStatusSchema,
});

export const meResponseSchema = z.object({
  mustChangePassword: z.boolean().optional(),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    twoFactorEnabled: z.boolean(),
  }),
  memberships: z.array(membershipSummarySchema),
  activeOrganizationId: z.string().nullable(),
  capabilities: z.array(capabilitySchema),
  assignedSiteIds: z.array(z.string()),
  mfaSetupRequired: z.boolean(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;
export type MembershipSummary = z.infer<typeof membershipSummarySchema>;

export const switchOrganizationSchema = z.strictObject({
  organizationId: objectIdSchema,
});

export const sessionSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;
