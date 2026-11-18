import { z } from 'zod';

export const siteReviewCreateSchema = z.strictObject({
  rating: z.number().int().min(1, 'Choose a rating.').max(5),
  comment: z.string().trim().min(3, 'Add a short comment.').max(1000),
});

export type SiteReviewCreateInput = z.infer<typeof siteReviewCreateSchema>;

export const siteReviewUpdateSchema = z
  .strictObject({
    rating: z.number().int().min(1).max(5).optional(),
    comment: z.string().trim().min(3).max(1000).optional(),
    version: z.number().int().min(1),
  })
  .refine((value) => Object.keys(value).length > 1, 'Provide a change and the current version.');

export type SiteReviewUpdateInput = z.infer<typeof siteReviewUpdateSchema>;

export const siteReviewSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  siteName: z.string(),
  memberId: z.string(),
  memberName: z.string(),
  rating: z.number(),
  comment: z.string(),
  mine: z.boolean(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SiteReview = z.infer<typeof siteReviewSchema>;

export const siteReviewListSchema = z.object({
  reviews: z.array(siteReviewSchema),
  averageRating: z.number().nullable(),
  reviewCount: z.number(),
  mine: siteReviewSchema.nullable(),
});

export type SiteReviewList = z.infer<typeof siteReviewListSchema>;
