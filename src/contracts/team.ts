import { z } from 'zod';
import { objectIdSchema } from './ids.js';
import { roleSchema } from './auth.js';

export const memberStatusUpdateSchema = z.strictObject({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  reason: z.string().trim().min(5, 'Explain the change in at least 5 characters.').max(300),
  expectedVersion: z.number().int().min(1),
});

export type MemberStatusUpdate = z.infer<typeof memberStatusUpdateSchema>;

export const memberRemovalSchema = z.strictObject({
  reason: z.string().trim().min(5, 'Explain the change in at least 5 characters.').max(300),
  expectedVersion: z.number().int().min(1),
});

export type MemberRemoval = z.infer<typeof memberRemovalSchema>;

export const memberRemovalSummarySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  membershipsRevoked: z.number(),
  assignmentsEnded: z.number(),
  invitationsRevoked: z.number(),
  sitesCleared: z.number(),
});

export type MemberRemovalSummary = z.infer<typeof memberRemovalSummarySchema>;

export const memberQuerySchema = z.strictObject({
  message: z.string().trim().min(5, 'Write at least 5 characters.').max(500),
  siteId: objectIdSchema.optional(),
});

export type MemberQueryInput = z.infer<typeof memberQuerySchema>;

export const teamMemberSiteSchema = z.object({
  assignmentId: z.string(),
  id: z.string(),
  name: z.string(),
  presence: z.enum(['UNKNOWN', 'INSIDE', 'EXIT_PENDING', 'OUTSIDE', 'NOT_WORKING']),
  clockedInAt: z.string().nullable(),
  shiftId: z.string().nullable(),
  assignedAt: z.string(),
});

export const teamMemberShiftSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  siteName: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(['WORKING', 'ENDED']),
  reviewState: z.enum(['ACCEPTED', 'NEEDS_REVIEW', 'REJECTED']),
  durationMinutes: z.number().nullable(),
});

export const teamMemberCorrectionSchema = z.object({
  id: z.string(),
  siteName: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  requestedAt: z.string(),
  proposedStartAt: z.string(),
  proposedEndAt: z.string().nullable(),
});

export const teamMemberQuerySchema = z.object({
  id: z.string(),
  at: z.string(),
  message: z.string(),
  byName: z.string().nullable(),
});

export const teamMemberSummarySchema = z.object({
  memberId: z.string(),
  name: z.string(),
  email: z.string(),
  role: roleSchema,
  phone: z.string().optional(),
  canUpdateSiteLocation: z.boolean().optional(),
  title: z.string().nullable(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']),
  membershipId: z.string(),
  membershipVersion: z.number(),
  joinedAt: z.string(),
  sites: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      presence: z.enum(['UNKNOWN', 'INSIDE', 'EXIT_PENDING', 'OUTSIDE', 'NOT_WORKING']),
      clockedInAt: z.string().nullable(),
      shiftId: z.string().nullable(),
    }),
  ),
});

export type TeamMemberSummary = z.infer<typeof teamMemberSummarySchema>;

export const teamMemberDetailSchema = z.object({
  member: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role: roleSchema,
  phone: z.string().optional(),
  canUpdateSiteLocation: z.boolean().optional(),
    title: z.string().nullable(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']),
    membershipId: z.string(),
    membershipVersion: z.number(),
    joinedAt: z.string(),
  }),
  sites: z.array(teamMemberSiteSchema),
  recentShifts: z.array(teamMemberShiftSchema),
  corrections: z.array(teamMemberCorrectionSchema),
  queries: z.array(teamMemberQuerySchema),
  openAlerts: z.number(),
});

export type TeamMemberDetail = z.infer<typeof teamMemberDetailSchema>;
export type TeamMemberQuery = z.infer<typeof teamMemberQuerySchema>;
