import { z } from 'zod';
import { isoDateTimeSchema, objectIdSchema } from './ids.js';

const reportTitle = z.string().trim().min(3, 'Give the report a title.').max(140);
const reportBody = z.string().trim().min(1, 'Write the report.').max(10000);

export const reportCreateSchema = z.strictObject({
  title: reportTitle,
  body: reportBody,
  siteId: objectIdSchema.optional(),
  reportDate: isoDateTimeSchema.optional(),
});

export type ReportCreateInput = z.infer<typeof reportCreateSchema>;

export const reportUpdateSchema = z
  .strictObject({
    title: reportTitle.optional(),
    body: reportBody.optional(),
    siteId: objectIdSchema.nullable().optional(),
    reportDate: isoDateTimeSchema.optional(),
    version: z.number().int().min(1),
  })
  .refine((value) => Object.keys(value).length > 1, 'Provide a change and the current version.');

export type ReportUpdateInput = z.infer<typeof reportUpdateSchema>;

export const reportSummarySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  siteId: z.string().nullable(),
  siteName: z.string().nullable(),
  kind: z.enum(['GENERAL', 'SITE', 'INSPECTION']),
  authorId: z.string(),
  authorName: z.string(),
  title: z.string(),
  body: z.string(),
  reportDate: z.string(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ReportSummary = z.infer<typeof reportSummarySchema>;
