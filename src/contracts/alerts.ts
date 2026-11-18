import { z } from 'zod';

export type AlertState = 'UNREAD' | 'READ' | 'REVIEWED';

export const alertSummarySchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  siteId: z.string(),
  siteName: z.string(),
  workerName: z.string(),
  workerId: z.string(),
  state: z.enum(['UNREAD', 'READ', 'REVIEWED']),
  detectedAt: z.string(),
  receivedAt: z.string(),
  lastUpdateAt: z.string().nullable(),
  stillWorking: z.boolean(),
  createdAt: z.string(),
});

export type AlertSummary = z.infer<typeof alertSummarySchema>;

export const alertDetailSchema = alertSummarySchema.extend({
  shiftId: z.string().nullable(),
  explanation: z.string(),
  detectionLatitude: z.number().nullable(),
  detectionLongitude: z.number().nullable(),
  detectionAccuracyMeters: z.number().nullable(),
  distanceMeters: z.number().nullable(),
  radiusMeters: z.number(),
  shiftStartedAt: z.string(),
  review: z
    .object({
      decision: z.enum(['ACKNOWLEDGED', 'CONTACTED', 'DISMISSED']),
      note: z.string().nullable(),
      reviewedAt: z.string(),
      reviewedBy: z.string(),
    })
    .nullable(),
  events: z.array(
    z.object({
      at: z.string(),
      label: z.string(),
      detail: z.string().nullable(),
    }),
  ),
});

export type AlertDetail = z.infer<typeof alertDetailSchema>;

export const alertReviewSchema = z.strictObject({
  decision: z.enum(['ACKNOWLEDGED', 'CONTACTED', 'DISMISSED']),
  note: z.string().trim().max(500).optional(),
});

export type AlertReview = z.infer<typeof alertReviewSchema>;

export const incidentSummarySchema = z.object({
  id: z.string(),
  state: z.enum(['CANDIDATE', 'CONFIRMED', 'RETURNED', 'CANCELLED']),
  workerId: z.string(),
  siteId: z.string(),
  shiftId: z.string(),
  detectedAt: z.string(),
  confirmedAt: z.string().nullable(),
  returnedAt: z.string().nullable(),
});
