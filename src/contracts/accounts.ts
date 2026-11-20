import { z } from 'zod';
import { objectIdSchema } from './ids.js';
import { passwordSchema, roleSchema } from './auth.js';

export const accountCreateSchema = z.strictObject({
  organizationId: objectIdSchema,
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((email) => email.toLowerCase()),
  phone: z.string().trim().min(5).max(30),
  role: roleSchema,
  siteIds: z.array(objectIdSchema).max(100).default([]),
  canUpdateSiteLocation: z.boolean().default(false),
});
export type AccountCreateInput = z.infer<typeof accountCreateSchema>;

export const staffProfileUpdateSchema = z.strictObject({
  email: z.email().transform((email) => email.toLowerCase()).optional(),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(5).max(30),
  role: z.enum(['STAFF', 'SUPERVISOR']),
  canUpdateSiteLocation: z.boolean(),
  expectedVersion: z.number().int().min(1),
});
export type StaffProfileUpdate = z.infer<typeof staffProfileUpdateSchema>;

export const accountProfileSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((email) => email.toLowerCase()),
  phone: z.string().trim().min(5).max(30),
});

export const initialPasswordSchema = z.strictObject({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
}).refine((input) => input.currentPassword !== input.newPassword, 'Choose a different password.');
