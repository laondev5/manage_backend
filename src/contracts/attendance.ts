import { z } from 'zod';
import { isoDateTimeSchema, objectIdSchema, uuidSchema } from './ids.js';

export const ATTENDANCE_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  WORKING: 'WORKING',
  ENDED: 'ENDED',
} as const;

export const attendanceStatusSchema = z.enum(['NOT_STARTED', 'WORKING', 'ENDED']);
export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;

export const presenceStateSchema = z.enum(['UNKNOWN', 'INSIDE', 'EXIT_PENDING', 'OUTSIDE']);
export type PresenceState = z.infer<typeof presenceStateSchema>;

export const syncStateSchema = z.enum(['LOCAL_PENDING', 'ACCEPTED', 'NEEDS_REVIEW', 'REJECTED']);
export type SyncState = z.infer<typeof syncStateSchema>;

export const locationReadingSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(0).max(10000),
  capturedAt: isoDateTimeSchema,
});

export type LocationReading = z.infer<typeof locationReadingSchema>;

export const attendanceEventTypeSchema = z.enum(['CLOCK_IN', 'CLOCK_OUT']);
export type AttendanceEventType = z.infer<typeof attendanceEventTypeSchema>;

export const attendanceEventInputSchema = z.strictObject({
  clientEventId: uuidSchema,
  clientShiftId: uuidSchema,
  deviceId: z.string().min(8).max(160),
  siteId: objectIdSchema,
  type: attendanceEventTypeSchema,
  capturedAt: isoDateTimeSchema,
  location: locationReadingSchema.nullable().optional(),
  sitePolicyVersion: z.number().int().min(1).optional(),
  note: z.string().trim().max(500).optional(),
});

export type AttendanceEventInput = z.infer<typeof attendanceEventInputSchema>;

export const syncBatchSchema = z.strictObject({
  events: z.array(attendanceEventInputSchema).min(1).max(50),
});

export const syncItemResultSchema = z.object({
  clientEventId: z.string(),
  outcome: z.enum(['ACCEPTED', 'NEEDS_REVIEW', 'REJECTED', 'DUPLICATE']),
  eventId: z.string().nullable(),
  shiftId: z.string().nullable(),
  message: z.string(),
  reviewReason: z.string().nullable(),
});

export type SyncItemResult = z.infer<typeof syncItemResultSchema>;

export const attendanceEventSchema = z.object({
  id: z.string(),
  type: z.enum(['CLOCK_IN', 'CLOCK_OUT', 'CLOCK_OUT_EXCEPTION', 'AMENDMENT']),
  outcome: z.enum(['ACCEPTED', 'NEEDS_REVIEW', 'REJECTED']),
  capturedAt: z.string(),
  receivedAt: z.string(),
  siteId: z.string(),
  siteName: z.string().optional(),
  accuracyMeters: z.number().nullable(),
  distanceMeters: z.number().nullable(),
  reviewReason: z.string().nullable(),
  note: z.string().nullable(),
  amended: z.boolean().optional(),
});

export type AttendanceEvent = z.infer<typeof attendanceEventSchema>;

export const shiftSummarySchema = z.object({
  id: z.string(),
  siteId: z.string(),
  siteName: z.string(),
  status: z.enum(['WORKING', 'ENDED']),
  reviewState: z.enum(['ACCEPTED', 'NEEDS_REVIEW', 'REJECTED']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMinutes: z.number().nullable(),
  timezone: z.string(),
  presence: presenceStateSchema,
  lastLocationUpdateAt: z.string().nullable(),
  reviewReason: z.string().nullable(),
  pendingCorrection: z.boolean().optional(),
});

export type ShiftSummary = z.infer<typeof shiftSummarySchema>;

export const currentShiftResponseSchema = z.object({
  serverTime: z.string(),
  activeShift: shiftSummarySchema.nullable(),
  lastEndedShift: shiftSummarySchema.nullable(),
  pendingLocalEvents: z.number().optional(),
});

export type CurrentShiftResponse = z.infer<typeof currentShiftResponseSchema>;

export const shiftDetailSchema = shiftSummarySchema.extend({
  siteAddress: z.string(),
  radiusMeters: z.number(),
  expectedHours: z
    .object({ start: z.string(), end: z.string(), days: z.array(z.number()) })
    .nullable(),
  events: z.array(attendanceEventSchema),
  observationsSummary: z.object({
    count: z.number(),
    lastAccuracyMeters: z.number().nullable(),
    lastCapturedAt: z.string().nullable(),
  }),
  receipt: z
    .object({
      workedMinutes: z.number(),
      startedAt: z.string(),
      endedAt: z.string(),
      note: z.string().nullable(),
    })
    .nullable(),
});

export type ShiftDetail = z.infer<typeof shiftDetailSchema>;

export const observationInputSchema = z.strictObject({
  clientObservationId: uuidSchema,
  shiftId: objectIdSchema,
  siteId: objectIdSchema,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(0).max(10000),
  capturedAt: isoDateTimeSchema,
  source: z.enum(['FOREGROUND', 'BACKGROUND', 'MANUAL']).default('BACKGROUND'),
});

export const observationAcceptedSchema = z.object({
  accepted: z.boolean(),
  presence: presenceStateSchema,
  recordedAt: z.string(),
  reason: z.string().nullable(),
});
