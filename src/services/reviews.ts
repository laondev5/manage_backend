import { ObjectId } from 'mongodb';
import {
  conflict,
  forbidden,
  notFound,
  type SiteReview,
  type SiteReviewCreateInput,
  type SiteReviewList,
  type SiteReviewUpdateInput,
} from '../contracts/index.js';
import { canReadSite } from '../domain/index.js';
import {
  appendAudit,
  findActiveAssignment,
  findSite,
  isDuplicateKey,
  usersByIds,
  type Database,
  type SiteReviewDoc,
} from '../database/index.js';
import type { AuthContext } from '../http/context.js';

async function readableSite(db: Database, auth: AuthContext, siteId: ObjectId) {
  const site = await findSite(db.c, siteId);
  if (!site || site.deletedAt) throw notFound('Site not found.');
  if (
    !canReadSite(auth.actor, {
      organizationId: site.organizationId.toHexString(),
      id: site._id.toHexString(),
    })
  ) {
    throw notFound('Site not found.');
  }
  return site;
}

async function toReview(
  db: Database,
  doc: SiteReviewDoc,
  siteName: string,
  viewerId: string,
): Promise<SiteReview> {
  const users = await usersByIds(db.c, [doc.memberId]);
  return {
    id: doc._id.toHexString(),
    siteId: doc.siteId.toHexString(),
    siteName,
    memberId: doc.memberId,
    memberName: users.get(doc.memberId)?.name ?? 'Team member',
    rating: doc.rating,
    comment: doc.comment,
    mine: doc.memberId === viewerId,
    version: doc.version,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function listSiteReviews(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
): Promise<SiteReviewList> {
  const site = await readableSite(db, auth, siteId);
  const docs = await db.c.siteReviews
    .find({ siteId: site._id, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();
  const reviews = await Promise.all(
    docs.map((doc) => toReview(db, doc, site.name, auth.user.id)),
  );
  const averageRating = reviews.length
    ? Math.round((reviews.reduce((total, review) => total + review.rating, 0) / reviews.length) * 10) / 10
    : null;
  return {
    reviews,
    averageRating,
    reviewCount: reviews.length,
    mine: reviews.find((review) => review.mine) ?? null,
  };
}

export async function createSiteReview(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  input: SiteReviewCreateInput,
  requestId: string,
): Promise<SiteReview> {
  const site = await readableSite(db, auth, siteId);
  if (!auth.capabilities.includes('staff.clock')) {
    throw forbidden('Only staff members can review a site.');
  }
  const assignment = await findActiveAssignment(db.c, site._id, auth.user.id);
  if (!assignment) {
    throw forbidden('Only staff assigned to this site can review it.');
  }
  const now = new Date();
  const review: SiteReviewDoc = {
    _id: new ObjectId(),
    organizationId: site.organizationId,
    siteId: site._id,
    memberId: auth.user.id,
    rating: input.rating,
    comment: input.comment,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  try {
    await db.c.siteReviews.insertOne(review);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw conflict('You already reviewed this site. Edit your review instead.');
    }
    throw error;
  }
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'site.review_created',
    targetType: 'site',
    targetId: site._id.toHexString(),
    organizationId: site.organizationId,
    siteId: site._id,
    requestId,
    summary: `Reviewed ${site.name}.`,
    meta: { rating: review.rating },
  });
  return toReview(db, review, site.name, auth.user.id);
}

export async function updateSiteReview(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  reviewId: ObjectId,
  input: SiteReviewUpdateInput,
): Promise<SiteReview> {
  const site = await readableSite(db, auth, siteId);
  const $set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.rating !== undefined) $set.rating = input.rating;
  if (input.comment !== undefined) $set.comment = input.comment;
  const updated = await db.c.siteReviews.findOneAndUpdate(
    {
      _id: reviewId,
      siteId: site._id,
      memberId: auth.user.id,
      version: input.version,
      deletedAt: null,
    },
    { $set, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  if (!updated) {
    throw conflict('This review changed since you loaded it. Refresh and try again.', 'STALE_VERSION');
  }
  return toReview(db, updated, site.name, auth.user.id);
}

export async function deleteSiteReview(
  db: Database,
  auth: AuthContext,
  siteId: ObjectId,
  reviewId: ObjectId,
): Promise<{ ok: true }> {
  await readableSite(db, auth, siteId);
  const deleted = await db.c.siteReviews.findOneAndUpdate(
    { _id: reviewId, siteId, memberId: auth.user.id, deletedAt: null },
    { $set: { deletedAt: new Date(), updatedAt: new Date() }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  if (!deleted) throw notFound('Review not found.');
  return { ok: true };
}
