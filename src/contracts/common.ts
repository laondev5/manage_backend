import { z } from 'zod';

export const pageQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

export const dateRangeSchema = z
  .object({
    from: z.iso.datetime({ offset: true }).or(z.iso.datetime()),
    to: z.iso.datetime({ offset: true }).or(z.iso.datetime()),
  })
  .refine((value) => new Date(value.from) < new Date(value.to), {
    message: 'The start of the range must be before the end.',
    path: ['to'],
  });

export const emptyResponseSchema = z.object({ ok: z.literal(true) });
