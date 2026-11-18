import { z } from 'zod';
import { objectIdSchema } from './ids.js';
import { roleSchema } from './auth.js';

export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Use a valid IANA timezone, for example Africa/Lagos.');

export const coordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const sitePolicySchema = z.object({
  radiusMeters: z.number().int().min(50, 'Use at least 50 m.').max(2000, 'Use at most 2,000 m.'),
  exitBufferMeters: z.number().int().min(0).max(500).default(30),
  entryBufferMeters: z.number().int().min(0).max(500).default(15),
  graceSeconds: z.number().int().min(30).max(1800).default(120),
  maxAccuracyMeters: z.number().int().min(5).max(200).default(50),
  freshnessSeconds: z.number().int().min(30).max(600).default(120),
});

export type SitePolicy = z.infer<typeof sitePolicySchema>;

export const expectedHoursSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.'),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.'),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
});

export type ExpectedHours = z.infer<typeof expectedHoursSchema>;

export const notificationPreferencesSchema = z.object({
  email: z.boolean().default(true),
  push: z.boolean().default(true),
  onDutyAlerts: z.boolean().default(true),
});

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const siteCreateSchema = z.strictObject({
  organizationId: objectIdSchema,
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().min(4).max(300),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: timezoneSchema,
  policy: sitePolicySchema,
  expectedHours: expectedHoursSchema.optional(),
  notificationPreferences: notificationPreferencesSchema.optional(),
});

export const siteUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(2).max(120).optional(),
    address: z.string().trim().min(4).max(300).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    timezone: timezoneSchema.optional(),
    policy: sitePolicySchema.partial().optional(),
    expectedHours: expectedHoursSchema.nullable().optional(),
    notificationPreferences: notificationPreferencesSchema.partial().optional(),
    version: z.number().int().min(1),
  })
  .refine((value) => Object.keys(value).length > 1, 'Provide a change and the current version.');

export type SiteCreateInput = z.infer<typeof siteCreateSchema>;
export type SiteUpdateInput = z.infer<typeof siteUpdateSchema>;

export const siteLifecycleSchema = z.strictObject({
  action: z.enum(['archive', 'restore', 'delete']),
  version: z.number().int().min(1),
  note: z.string().trim().max(300).optional(),
});

export type SiteLifecycleInput = z.infer<typeof siteLifecycleSchema>;

export const siteSummarySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  organizationName: z.string().optional(),
  name: z.string(),
  address: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string(),
  radiusMeters: z.number(),
  policyVersion: z.number(),
  expectedHours: z
    .object({ start: z.string(), end: z.string(), days: z.array(z.number()) })
    .nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  archivedAt: z.string().nullable().optional(),
  teamLeadId: z.string().nullable().optional(),
  teamLeadName: z.string().nullable().optional(),
  inspectorId: z.string().nullable().optional(),
  inspectorName: z.string().nullable().optional(),
  /** Staff only: when the caller accepted their assignment to this site. */
  assignmentAcceptedAt: z.string().nullable().optional(),
  staffCount: z.number().optional(),
  onSiteCount: z.number().optional(),
});

export type SiteSummary = z.infer<typeof siteSummarySchema>;

export const siteDetailSchema = siteSummarySchema.extend({
  policy: z.object({
    radiusMeters: z.number(),
    exitBufferMeters: z.number(),
    entryBufferMeters: z.number(),
    graceSeconds: z.number(),
    maxAccuracyMeters: z.number(),
    freshnessSeconds: z.number(),
  }),
  notificationPreferences: z.object({
    email: z.boolean(),
    push: z.boolean(),
    onDutyAlerts: z.boolean(),
  }),
  version: z.number(),
});

export type SiteDetail = z.infer<typeof siteDetailSchema>;

export const assignmentCreateSchema = z.strictObject({
  memberId: z.string().min(1),
  permissionScope: z.enum(['CLOCK_ONLY', 'CLOCK_AND_HISTORY']).default('CLOCK_AND_HISTORY'),
  effectiveFrom: z.iso.datetime({ offset: true }).or(z.iso.datetime()).optional(),
});

export const rosterEntrySchema = z.object({
  memberId: z.string(),
  name: z.string(),
  email: z.string(),
  role: roleSchema,
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']),
  assignedAt: z.string(),
  acceptedAt: z.string().nullable().optional(),
  isTeamLead: z.boolean().optional(),
  presence: z.enum(['UNKNOWN', 'INSIDE', 'EXIT_PENDING', 'OUTSIDE', 'NOT_WORKING']),
  shiftId: z.string().nullable(),
  clockedInAt: z.string().nullable(),
  lastUpdateAt: z.string().nullable(),
});

export type RosterEntry = z.infer<typeof rosterEntrySchema>;

export const assignmentAcceptResponseSchema = z.object({
  siteId: z.string(),
  acceptedAt: z.string(),
});

export const teamLeadUpdateSchema = z.strictObject({
  memberId: z.string().min(1).nullable(),
});

export type TeamLeadUpdateInput = z.infer<typeof teamLeadUpdateSchema>;

export const teamLeadResponseSchema = z.object({
  siteId: z.string(),
  teamLeadId: z.string().nullable(),
  teamLeadName: z.string().nullable(),
});

export const siteInspectorUpdateSchema = z.strictObject({
  inspectorId: z.string().min(1).nullable(),
});

export type SiteInspectorUpdateInput = z.infer<typeof siteInspectorUpdateSchema>;

export const siteInspectorResponseSchema = z.object({
  siteId: z.string(),
  inspectorId: z.string().nullable(),
  inspectorName: z.string().nullable(),
  inspectingSelf: z.boolean(),
});

export const invitationSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  siteId: z.string().nullable(),
  siteName: z.string().nullable(),
  organizationId: z.string(),
  role: roleSchema,
  status: z.enum(['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED']),
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
});

export type InvitationSummary = z.infer<typeof invitationSummarySchema>;
