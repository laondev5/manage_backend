import { z } from 'zod';

export const deviceRegistrationSchema = z.strictObject({
  deviceId: z.string().min(8).max(160),
  platform: z.enum(['ios', 'android']),
  pushToken: z.string().max(400).nullable().optional(),
  appVersion: z.string().max(40).optional(),
  pushEnabled: z.boolean().default(false),
});

export const deviceSummarySchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  platform: z.enum(['ios', 'android']),
  appVersion: z.string().nullable(),
  pushEnabled: z.boolean(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

export const onboardingStateSchema = z.object({
  staff: z.object({
    detailsConfirmed: z.boolean(),
    siteReviewed: z.boolean(),
    readinessCompleted: z.boolean(),
    completedAt: z.string().nullable(),
  }),
  owner: z.object({
    siteDetailsDone: z.boolean(),
    boundaryDone: z.boolean(),
    inviteDone: z.boolean(),
    alertsReviewed: z.boolean(),
    completedAt: z.string().nullable(),
  }),
});

export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const onboardingUpdateSchema = z.strictObject({
  step: z.enum([
    'detailsConfirmed',
    'siteReviewed',
    'readinessCompleted',
    'siteDetailsDone',
    'boundaryDone',
    'inviteDone',
    'alertsReviewed',
  ]),
  value: z.boolean(),
});
