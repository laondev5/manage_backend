import { z } from 'zod';
import { isoDateTimeSchema, objectIdSchema } from './ids.js';

export const correctionCreateSchema = z.strictObject({
  shiftId: objectIdSchema,
  proposedStartAt: isoDateTimeSchema,
  proposedEndAt: isoDateTimeSchema.nullable(),
  reason: z.string().trim().min(10, 'Explain the correction in at least 10 characters.').max(800),
});

export type CorrectionCreateInput = z.infer<typeof correctionCreateSchema>;

export const correctionDecisionSchema = z.strictObject({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().max(500).optional(),
  expectedVersion: z.number().int().min(1),
});

export const correctionSummarySchema = z.object({
  id: z.string(),
  shiftId: z.string(),
  siteId: z.string(),
  siteName: z.string(),
  workerId: z.string(),
  workerName: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  originalStartAt: z.string(),
  originalEndAt: z.string().nullable(),
  proposedStartAt: z.string(),
  proposedEndAt: z.string().nullable(),
  reason: z.string(),
  requestNote: z.string().nullable(),
  requestedAt: z.string(),
  reviewedAt: z.string().nullable(),
  reviewerName: z.string().nullable(),
  reviewerNote: z.string().nullable(),
  version: z.number(),
});

export type CorrectionSummary = z.infer<typeof correctionSummarySchema>;

export const correctionDetailSchema = correctionSummarySchema.extend({
  auditTrail: z.array(
    z.object({
      at: z.string(),
      action: z.string(),
      actorName: z.string().nullable(),
      detail: z.string().nullable(),
    }),
  ),
});

export type CorrectionDetail = z.infer<typeof correctionDetailSchema>;

export const timesheetRowSchema = z.object({
  shiftId: z.string(),
  workerName: z.string(),
  siteName: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  minutes: z.number().nullable(),
  timezone: z.string(),
  status: z.enum(['WORKING', 'ENDED']),
  reviewState: z.enum(['ACCEPTED', 'NEEDS_REVIEW', 'REJECTED']),
});

export type TimesheetRow = z.infer<typeof timesheetRowSchema>;

export const exportRequestSchema = z.strictObject({
  organizationId: objectIdSchema,
  siteId: objectIdSchema.optional(),
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
});

export const exportResultSchema = z.object({
  id: z.string(),
  filename: z.string(),
  rowCount: z.number(),
  generatedAt: z.string(),
  csv: z.string(),
});

export type ExportResult = z.infer<typeof exportResultSchema>;
