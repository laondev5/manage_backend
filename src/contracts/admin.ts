import { z } from 'zod';
import { objectIdSchema } from './ids.js';
import { roleSchema } from './auth.js';

export const organizationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']),
  siteCount: z.number(),
  memberCount: z.number(),
  workingNow: z.number(),
  createdAt: z.string(),
});

export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;

export const organizationCreateSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  contactEmail: z.email(),
  timezone: z.string().min(1).max(64).default('Africa/Lagos'),
});

export const organizationUpdateSchema = z.strictObject({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
  contactEmail: z.email().optional(),
  version: z.number().int().min(1),
});

export const accessGrantCreateSchema = z.strictObject({
  adminUserId: z.string().min(1),
  organizationId: objectIdSchema,
  siteId: objectIdSchema.nullable().optional(),
  capability: z.enum([
    'admin.attendance_read',
    'admin.location_read',
    'admin.corrections_support',
    'admin.exports',
  ]),
  expiresAt: z.iso.datetime({ offset: true }).or(z.iso.datetime()),
  reason: z.string().trim().min(5).max(300),
});

export const accessGrantSummarySchema = z.object({
  id: z.string(),
  adminUserId: z.string(),
  adminName: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  siteId: z.string().nullable(),
  siteName: z.string().nullable(),
  capability: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
});

export const adminUserSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  memberships: z.array(
    z.object({
      organizationId: z.string(),
      organizationName: z.string(),
      role: roleSchema,
      status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']),
    }),
  ),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
});

export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

export const membershipUpdateSchema = z.strictObject({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']).optional(),
  role: z.enum(['STAFF', 'SITE_OWNER']).optional(),
  reason: z.string().trim().min(5).max(300),
});

export const auditEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  actorRole: z.string().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  organizationId: z.string().nullable(),
  siteId: z.string().nullable(),
  requestId: z.string().nullable(),
  summary: z.string(),
  hash: z.string(),
  previousHash: z.string().nullable(),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

export const adminOverviewSchema = z.object({
  organizations: z.number(),
  activeSites: z.number(),
  workingNow: z.number(),
  openAlerts: z.number(),
  pendingCorrections: z.number(),
  outboxBacklog: z.number(),
  failedDeliveries: z.number(),
  stalePresence: z.number(),
  generatedAt: z.string(),
});

export type AdminOverview = z.infer<typeof adminOverviewSchema>;

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  database: z.enum(['ok', 'down']),
  worker: z.object({
    lastHeartbeatAt: z.string().nullable(),
    ageSeconds: z.number().nullable(),
    state: z.enum(['ok', 'stale', 'unknown']),
    mode: z.enum(['loop', 'scheduled', 'unknown']),
    staleAfterSeconds: z.number(),
  }),
  outbox: z.object({
    pending: z.number(),
    leased: z.number(),
    dead: z.number(),
    oldestPendingAt: z.string().nullable(),
  }),
  push: z.object({ provider: z.enum(['expo', 'local']), configured: z.boolean() }),
  email: z.object({ provider: z.enum(['resend', 'local']), configured: z.boolean() }),
  checkedAt: z.string(),
});

export type Health = z.infer<typeof healthSchema>;

export const retryOutboxSchema = z.strictObject({
  outboxIds: z.array(z.string()).min(1).max(100),
});

export const platformSiteSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  radiusMeters: z.number(),
  timezone: z.string(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  policyVersion: z.number(),
  version: z.number(),
  staffCount: z.number(),
});

export type PlatformSiteSummary = z.infer<typeof platformSiteSummarySchema>;

export const platformSiteUpdateSchema = z.strictObject({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  radiusMeters: z.number().int().min(50).max(2000).optional(),
  timezone: z.string().min(1).max(64).optional(),
  version: z.number().int().min(1),
  reason: z.string().trim().min(5).max(300),
});

export const ownerOverviewSchema = z.object({
  organizationId: z.string(),
  staffOnSite: z.number(),
  staffAssigned: z.number(),
  openAlerts: z.number(),
  pendingCorrections: z.number(),
  hoursToday: z.number(),
  sites: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      onSiteCount: z.number(),
      assignedCount: z.number(),
      openAlerts: z.number(),
      presenceUncertain: z.number(),
    }),
  ),
  recentAlerts: z.array(
    z.object({
      id: z.string(),
      siteName: z.string(),
      workerName: z.string(),
      detectedAt: z.string(),
      state: z.enum(['UNREAD', 'READ', 'REVIEWED']),
    }),
  ),
  generatedAt: z.string(),
});

export type OwnerOverview = z.infer<typeof ownerOverviewSchema>;
