import { ObjectId } from 'mongodb';
import {
  AppError,
  conflict,
  forbidden,
  notFound,
  validationError,
  type CorrectionCreateInput,
  type CorrectionDetail,
  type CorrectionSummary,
} from '../contracts/index.js';
import { canReviewCorrections } from '../domain/index.js';
import {
  appendAudit,
  applyShiftAmendment,
  createCorrection,
  decideCorrection,
  findCorrection,
  findPendingCorrectionForShift,
  findShiftById,
  findSite,
  isDuplicateKey,
  listCorrectionsForSites,
  listCorrectionsForWorker,
  usersByIds,
  withTransaction,
  type CorrectionDoc,
  type Database,
  type SiteDoc,
} from '../database/index.js';
import type { AuthContext } from '../http/context.js';

const MAX_LOOKUP = 100;

async function mappingContext(db: Database, docs: CorrectionDoc[]) {
  const siteIds = [...new Set(docs.map((doc) => doc.siteId.toHexString()))];
  const workerIds = [...new Set(docs.map((doc) => doc.workerId))];
  const reviewerIds = [...new Set(docs.map((doc) => doc.reviewerId).filter((id): id is string => Boolean(id)))];
  const sites = siteIds.length
    ? await db.c.sites.find({ _id: { $in: siteIds.map((id) => new ObjectId(id)) } }).toArray()
    : [];
  const users = await usersByIds(db.c, [...workerIds, ...reviewerIds]);
  const siteById = new Map<string, SiteDoc>(sites.map((site) => [site._id.toHexString(), site]));
  return { siteById, users };
}

function toSummary(
  doc: CorrectionDoc,
  siteById: Map<string, SiteDoc>,
  users: Map<string, { name: string }>,
): CorrectionSummary {
  const site = siteById.get(doc.siteId.toHexString());
  return {
    id: doc._id.toHexString(),
    shiftId: doc.shiftId.toHexString(),
    siteId: doc.siteId.toHexString(),
    siteName: site?.name ?? 'Unknown site',
    workerId: doc.workerId,
    workerName: users.get(doc.workerId)?.name ?? 'Unknown member',
    status: doc.status,
    originalStartAt: doc.originalStartAt.toISOString(),
    originalEndAt: doc.originalEndAt?.toISOString() ?? null,
    proposedStartAt: doc.proposedStartAt.toISOString(),
    proposedEndAt: doc.proposedEndAt?.toISOString() ?? null,
    reason: doc.reason,
    requestNote: doc.requestNote,
    requestedAt: doc.createdAt.toISOString(),
    reviewedAt: doc.reviewedAt?.toISOString() ?? null,
    reviewerName: doc.reviewerId ? users.get(doc.reviewerId)?.name ?? 'Reviewer' : null,
    reviewerNote: doc.reviewerNote,
    version: doc.version,
  };
}

export async function requestCorrection(
  db: Database,
  auth: AuthContext,
  input: CorrectionCreateInput,
  requestId: string,
): Promise<CorrectionSummary> {
  const shift = await findShiftById(db.c, new ObjectId(input.shiftId));
  if (!shift || shift.userId !== auth.user.id) throw notFound('Shift not found.');
  const site = await findSite(db.c, shift.siteId);
  if (!site) throw notFound('Site not found.');

  const start = new Date(input.proposedStartAt);
  const end = input.proposedEndAt ? new Date(input.proposedEndAt) : null;
  const now = new Date();
  if (end && end.getTime() <= start.getTime()) {
    throw validationError('The proposed end must be after the proposed start.', {
      proposedEndAt: ['Use a time after the start.'],
    });
  }
  if (start.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw validationError('A correction cannot start in the future.', {
      proposedStartAt: ['Use a time in the past.'],
    });
  }
  if (shift.status === 'ENDED' && !end) {
    throw validationError('An ended shift needs a proposed end time.', {
      proposedEndAt: ['Enter the corrected end time.'],
    });
  }
  if (shift.status === 'WORKING' && end) {
    throw validationError('Clock out before correcting an end time.', {
      proposedEndAt: ['This shift is still active.'],
    });
  }
  const pending = await findPendingCorrectionForShift(db.c, shift._id);
  if (pending) {
    throw conflict('A correction for this shift is already waiting for review.', 'CONFLICT');
  }

  const doc: CorrectionDoc = {
    _id: new ObjectId(),
    organizationId: shift.organizationId,
    siteId: shift.siteId,
    shiftId: shift._id,
    workerId: auth.user.id,
    requestedBy: auth.user.id,
    originalStartAt: shift.startedAt,
    originalEndAt: shift.endedAt,
    proposedStartAt: start,
    proposedEndAt: end,
    reason: input.reason,
    requestNote: null,
    status: 'PENDING',
    reviewerId: null,
    reviewerNote: null,
    reviewedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await createCorrection(db.c, doc);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw conflict('A correction for this shift is already waiting for review.');
    }
    throw error;
  }

  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'correction.requested',
    targetType: 'correction',
    targetId: doc._id.toHexString(),
    organizationId: doc.organizationId,
    siteId: doc.siteId,
    requestId,
    summary: `Correction requested for a shift at ${site.name}.`,
    meta: {
      shiftId: doc.shiftId.toHexString(),
      proposedStartAt: start.toISOString(),
      proposedEndAt: end?.toISOString() ?? null,
    },
  });

  return toSummary(doc, new Map([[site._id.toHexString(), site]]), (await mappingContext(db, [doc])).users);
}

export async function myCorrections(db: Database, auth: AuthContext) {
  const docs = await listCorrectionsForWorker(db.c, auth.user.id);
  const { siteById, users } = await mappingContext(db, docs);
  return docs.map((doc) => toSummary(doc, siteById, users));
}

export async function ownerCorrections(
  db: Database,
  auth: AuthContext,
  input: { status?: CorrectionDoc['status']; cursor?: string; limit: number },
) {
  const siteIds = auth.actor.ownedSiteIds.map((id) => new ObjectId(id));
  const result = await listCorrectionsForSites(db.c, siteIds, input.status, input.cursor, input.limit);
  const { siteById, users } = await mappingContext(db, result.items);
  return {
    items: result.items.map((doc) => toSummary(doc, siteById, users)),
    nextCursor: result.nextCursor,
  };
}

export async function correctionDetail(
  db: Database,
  auth: AuthContext,
  correctionId: ObjectId,
): Promise<CorrectionDetail> {
  const doc = await findCorrection(db.c, correctionId);
  if (!doc) throw notFound('Correction not found.');
  const site = await findSite(db.c, doc.siteId);
  if (!site) throw notFound('Site not found.');
  const isWorker = doc.workerId === auth.user.id;
  const isReviewer = canReviewCorrections(auth.actor, {
    organizationId: doc.organizationId.toHexString(),
    id: doc.siteId.toHexString(),
  });
  if (!isWorker && !isReviewer) throw notFound('Correction not found.');

  const { users } = await mappingContext(db, [doc]);
  const audit = await db.c.auditEvents
    .find({ targetType: 'correction', targetId: doc._id.toHexString() })
    .sort({ sequence: 1 })
    .limit(MAX_LOOKUP)
    .toArray();
  return {
    ...toSummary(doc, new Map([[site._id.toHexString(), site]]), users),
    auditTrail: audit.map((entry) => ({
      at: entry.at.toISOString(),
      action: entry.action,
      actorName: entry.actorName,
      detail: entry.summary,
    })),
  };
}

export async function decideCorrectionRequest(
  db: Database,
  auth: AuthContext,
  correctionId: ObjectId,
  input: { decision: 'APPROVE' | 'REJECT'; note?: string; expectedVersion: number },
  requestId: string,
): Promise<CorrectionDetail> {
  const doc = await findCorrection(db.c, correctionId);
  if (!doc) throw notFound('Correction not found.');
  if (doc.workerId === auth.user.id) {
    throw new AppError(
      403,
      'SELF_APPROVAL_FORBIDDEN',
      'You cannot approve or reject your own correction request.',
    );
  }
  const site = await findSite(db.c, doc.siteId);
  if (!site) throw notFound('Site not found.');
  if (
    !canReviewCorrections(auth.actor, {
      organizationId: doc.organizationId.toHexString(),
      id: doc.siteId.toHexString(),
    })
  ) {
    throw forbidden('You cannot review corrections for this site.');
  }
  if (doc.status !== 'PENDING') {
    throw conflict('This correction was already reviewed.');
  }
  const shift = await findShiftById(db.c, doc.shiftId);
  if (!shift) throw notFound('The shift for this correction could not be found.');

  if (input.decision === 'APPROVE') {
    if (shift.status === 'ENDED' && !doc.proposedEndAt) {
      throw conflict('This correction is missing an end time.');
    }
    if (shift.status === 'WORKING' && doc.proposedEndAt) {
      throw conflict('This shift is still active, so an end time cannot be applied.');
    }
  }

  const now = new Date();
  let updated: CorrectionDoc | null = null;

  await withTransaction(db, async (session) => {
    updated = await decideCorrection(
      db.c,
      {
        correctionId,
        expectedVersion: input.expectedVersion,
        status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        reviewerId: auth.user.id,
        reviewerNote: input.note ?? null,
      },
      session,
    );
    if (!updated) return;

    if (input.decision === 'APPROVE') {
      await applyShiftAmendment(
        db.c,
        {
          shiftId: shift._id,
          startedAt: doc.proposedStartAt,
          endedAt: doc.proposedEndAt,
          reviewState: 'ACCEPTED',
        },
        session,
      );
      await db.c.attendanceEvents.insertOne(
        {
          _id: new ObjectId(),
          organizationId: doc.organizationId,
          siteId: doc.siteId,
          shiftId: doc.shiftId,
          userId: doc.workerId,
          deviceId: 'correction-review',
          clientEventId: doc._id.toHexString(),
          clientShiftId: shift.clientShiftId,
          type: 'AMENDMENT',
          outcome: 'ACCEPTED',
          capturedAt: now,
          receivedAt: now,
          receivedOffsetSeconds: 0,
          location: null,
          accuracyMeters: null,
          distanceMeters: null,
          sitePolicyVersion: shift.policyVersion,
          reviewReason: null,
          note: `Correction ${doc._id.toHexString()} approved.`,
          syncState: 'ACCEPTED',
          correctionId: doc._id,
          requestId,
          createdAt: now,
        },
        { session },
      );
    }

    await appendAudit(
      db.c,
      {
        actorId: auth.user.id,
        actorName: auth.user.name,
        actorRole: auth.roles[0] ?? null,
        action: input.decision === 'APPROVE' ? 'correction.approved' : 'correction.rejected',
        targetType: 'correction',
        targetId: doc._id.toHexString(),
        organizationId: doc.organizationId,
        siteId: doc.siteId,
        requestId,
        summary: `${input.decision === 'APPROVE' ? 'Approved' : 'Rejected'} a correction at ${site.name}.`,
        meta: {
          shiftId: doc.shiftId.toHexString(),
          proposedStartAt: doc.proposedStartAt.toISOString(),
          proposedEndAt: doc.proposedEndAt?.toISOString() ?? null,
          note: input.note ?? null,
        },
      },
      session,
    );
  });

  if (!updated) {
    throw conflict('Someone else reviewed this correction first. Refresh to see the decision.', 'STALE_VERSION');
  }

  return correctionDetail(db, auth, correctionId);
}
