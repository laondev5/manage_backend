import { z } from 'zod';
import { isoDateTimeSchema, objectIdSchema } from './ids.js';

export const REPORT_BODY_LIMIT = 20_000;
export const REPORT_FIELD_LIMIT = 6;
export const REPORT_FIELD_BODY_LIMIT = 5_000;

const reportTitle = z.string().trim().min(3, 'Give the report a title.').max(140);
const reportBody = z.string().trim().min(1, 'Write the report.').max(REPORT_BODY_LIMIT);

/** The app sends rich text as HTML. Plain text stays supported for older clients. */
export const reportBodyFormatSchema = z.enum(['text', 'html']);
export type ReportBodyFormat = z.infer<typeof reportBodyFormatSchema>;

/** A report field: the reporter names it, then writes it in the rich text editor. */
export const reportFieldSchema = z.strictObject({
  heading: z.string().trim().min(1, 'Give the field a title.').max(120),
  body: z.string().trim().min(1, 'Write the field content.').max(REPORT_FIELD_BODY_LIMIT),
});

export const reportFieldsSchema = z
  .array(reportFieldSchema)
  .max(REPORT_FIELD_LIMIT, `A report can hold at most ${REPORT_FIELD_LIMIT} extra fields.`);

export type ReportField = z.infer<typeof reportFieldSchema>;

export const reportCreateSchema = z.strictObject({
  title: reportTitle,
  body: reportBody,
  bodyFormat: reportBodyFormatSchema.default('html'),
  fields: reportFieldsSchema.optional(),
  siteId: objectIdSchema.optional(),
  reportDate: isoDateTimeSchema.optional(),
});

export type ReportCreateInput = z.infer<typeof reportCreateSchema>;

export const reportUpdateSchema = z
  .strictObject({
    title: reportTitle.optional(),
    body: reportBody.optional(),
    bodyFormat: reportBodyFormatSchema.optional(),
    fields: reportFieldsSchema.optional(),
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
  bodyFormat: reportBodyFormatSchema,
  fields: z.array(reportFieldSchema),
  reportDate: z.string(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ReportSummary = z.infer<typeof reportSummarySchema>;
