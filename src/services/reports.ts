import { ObjectId } from 'mongodb';
import {
  conflict,
  forbidden,
  notFound,
  type ReportCreateInput,
  type ReportSummary,
  type ReportUpdateInput,
} from '../contracts/index.js';
import {
  appendAudit,
  findSite,
  findSitesByIds,
  usersByIds,
  type Database,
  type ReportDoc,
} from '../database/index.js';
import type { AuthContext } from '../http/context.js';

const REPORT_LIMIT = 200;

function requireOwnerReports(auth: AuthContext) {
  if (!auth.capabilities.includes('owner.reports')) {
    throw forbidden('Team reports are not available for this account.');
  }
}

async function reportScope(
  db: Database,
  auth: AuthContext,
  siteId: string | null | undefined,
): Promise<{ organizationId: ObjectId; siteId: ObjectId | null; kind: ReportDoc['kind'] }> {
  if (siteId) {
    const site = await findSite(db.c, new ObjectId(siteId));
    if (!site || site.deletedAt) throw notFound('Site not found.');
    const isAssignee = auth.actor.assignedSiteIds.includes(site._id.toHexString());
    const isInspector = site.inspectorId === auth.user.id;
    if (!isAssignee && !isInspector) {
      throw forbidden('Only staff assigned to this site or its inspector can report on it.');
    }
    return {
      organizationId: site.organizationId,
      siteId: site._id,
      kind: isInspector ? 'INSPECTION' : 'SITE',
    };
  }
  const membership = auth.context.memberships.find(
    (entry) =>
      entry.membership.role === 'STAFF' &&
      entry.membership.status === 'ACTIVE' &&
      entry.organization.status === 'ACTIVE',
  );
  if (!membership) {
    throw forbidden('General team reports are available for active staff accounts.');
  }
  return { organizationId: membership.organization._id, siteId: null, kind: 'GENERAL' };
}

async function toSummaries(
  db: Database,
  docs: ReportDoc[],
): Promise<ReportSummary[]> {
  if (!docs.length) return [];
  const siteIds = [
    ...new Set(docs.map((doc) => doc.siteId).filter((id): id is ObjectId => Boolean(id))),
  ];
  const [sites, users] = await Promise.all([
    findSitesByIds(db.c, siteIds),
    usersByIds(db.c, [...new Set(docs.map((doc) => doc.authorId))]),
  ]);
  const siteById = new Map(sites.map((site) => [site._id.toHexString(), site]));
  return docs.map((doc) => ({
    id: doc._id.toHexString(),
    organizationId: doc.organizationId.toHexString(),
    siteId: doc.siteId?.toHexString() ?? null,
    siteName: doc.siteId ? (siteById.get(doc.siteId.toHexString())?.name ?? null) : null,
    kind: doc.kind,
    authorId: doc.authorId,
    authorName: users.get(doc.authorId)?.name ?? 'Team member',
    title: doc.title,
    body: doc.body,
    reportDate: doc.reportDate.toISOString(),
    version: doc.version,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }));
}

export async function listReports(
  db: Database,
  auth: AuthContext,
  scope: 'mine' | 'team',
): Promise<ReportSummary[]> {
  if (scope === 'mine') {
    const docs = await db.c.reports
      .find({ authorId: auth.user.id, deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(REPORT_LIMIT)
      .toArray();
    return toSummaries(db, docs);
  }
  requireOwnerReports(auth);
  const organizationIds = auth.actor.ownedOrganizationIds.map((id) => new ObjectId(id));
  if (!organizationIds.length) return [];
  const docs = await db.c.reports
    .find({ organizationId: { $in: organizationIds }, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(REPORT_LIMIT)
    .toArray();
  return toSummaries(db, docs);
}

async function findReport(db: Database, auth: AuthContext, reportId: ObjectId): Promise<ReportDoc> {
  const report = await db.c.reports.findOne({ _id: reportId, deletedAt: null });
  if (!report) throw notFound('Report not found.');
  const isAuthor = report.authorId === auth.user.id;
  const isOwner =
    auth.capabilities.includes('owner.reports') &&
    auth.actor.ownedOrganizationIds.includes(report.organizationId.toHexString());
  if (!isAuthor && !isOwner) throw notFound('Report not found.');
  return report;
}

export async function getReport(
  db: Database,
  auth: AuthContext,
  reportId: ObjectId,
): Promise<ReportSummary> {
  const report = await findReport(db, auth, reportId);
  const [summary] = await toSummaries(db, [report]);
  if (!summary) throw notFound('Report not found.');
  return summary;
}

export async function createReport(
  db: Database,
  auth: AuthContext,
  input: ReportCreateInput,
  requestId: string,
): Promise<ReportSummary> {
  const scope = await reportScope(db, auth, input.siteId);
  const now = new Date();
  const report: ReportDoc = {
    _id: new ObjectId(),
    organizationId: scope.organizationId,
    siteId: scope.siteId,
    authorId: auth.user.id,
    kind: scope.kind,
    title: input.title,
    body: input.body,
    reportDate: input.reportDate ? new Date(input.reportDate) : now,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await db.c.reports.insertOne(report);
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'report.created',
    targetType: 'report',
    targetId: report._id.toHexString(),
    organizationId: report.organizationId,
    siteId: report.siteId,
    requestId,
    summary: `Submitted the report "${report.title}".`,
    meta: { siteId: report.siteId?.toHexString() ?? null },
  });
  const [summary] = await toSummaries(db, [report]);
  if (!summary) throw notFound('Report not found.');
  return summary;
}

export async function updateReport(
  db: Database,
  auth: AuthContext,
  reportId: ObjectId,
  input: ReportUpdateInput,
  requestId: string,
): Promise<ReportSummary> {
  const report = await db.c.reports.findOne({
    _id: reportId,
    authorId: auth.user.id,
    deletedAt: null,
  });
  if (!report) throw notFound('Report not found.');
  const scope =
    input.siteId !== undefined ? await reportScope(db, auth, input.siteId) : null;
  const $set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.title !== undefined) $set.title = input.title;
  if (input.body !== undefined) $set.body = input.body;
  if (input.reportDate !== undefined) $set.reportDate = new Date(input.reportDate);
  if (scope) {
    $set.siteId = scope.siteId;
    $set.organizationId = scope.organizationId;
    $set.kind = scope.kind;
  }
  const updated = await db.c.reports.findOneAndUpdate(
    { _id: report._id, authorId: auth.user.id, version: input.version, deletedAt: null },
    { $set, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  if (!updated) {
    throw conflict('This report changed since you loaded it. Refresh and try again.', 'STALE_VERSION');
  }
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'report.updated',
    targetType: 'report',
    targetId: updated._id.toHexString(),
    organizationId: updated.organizationId,
    siteId: updated.siteId,
    requestId,
    summary: `Updated the report "${updated.title}".`,
    meta: { version: updated.version },
  });
  const [summary] = await toSummaries(db, [updated]);
  if (!summary) throw notFound('Report not found.');
  return summary;
}

export async function deleteReport(
  db: Database,
  auth: AuthContext,
  reportId: ObjectId,
  requestId: string,
): Promise<{ ok: true }> {
  const report = await db.c.reports.findOneAndUpdate(
    { _id: reportId, authorId: auth.user.id, deletedAt: null },
    { $set: { deletedAt: new Date(), updatedAt: new Date() }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  if (!report) throw notFound('Report not found.');
  await appendAudit(db.c, {
    actorId: auth.user.id,
    actorName: auth.user.name,
    actorRole: auth.roles[0] ?? null,
    action: 'report.deleted',
    targetType: 'report',
    targetId: report._id.toHexString(),
    organizationId: report.organizationId,
    siteId: report.siteId,
    requestId,
    summary: `Deleted the report "${report.title}".`,
    meta: {},
  });
  return { ok: true };
}
