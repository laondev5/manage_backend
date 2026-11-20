import { ObjectId } from 'mongodb';
import { forbidden, notFound } from '../contracts/index.js';
import type { Database } from '../database/index.js';
import type { AuthContext } from '../http/context.js';

/** Cursor pagination includes historical assignments; current roster is not history. */
export async function activityHistory(db: Database, auth: AuthContext, input: {
  siteId?: string; memberId?: string; cursor?: string; limit: number;
}) {
  const admin = auth.roles.includes('PLATFORM_ADMIN');
  if (!admin && !auth.capabilities.includes('owner.team')) throw forbidden('Attendance history is for managers.');
  const scope = admin ? {} : { _id: { $in: auth.actor.ownedSiteIds.map((id) => new ObjectId(id)) } };
  const sites = await db.c.sites.find(input.siteId ? { ...scope, $and: [{ _id: new ObjectId(input.siteId) }, scope] } : scope).toArray();
  if (input.siteId && !sites.length) throw notFound('Site not found.');
  const filter = { siteId: { $in: sites.map((site) => site._id) }, ...(input.memberId ? { userId: input.memberId } : {}),
    ...(input.cursor ? { _id: { $lt: new ObjectId(input.cursor) } } : {}) };
  const rows = await db.c.shifts.find(filter).sort({ _id: -1 }).limit(input.limit + 1).toArray();
  const page = rows.slice(0, input.limit);
  const incidents = await db.c.incidents.find({ shiftId: { $in: page.map((shift) => shift._id) }, state: { $in: ['CONFIRMED', 'RETURNED'] } }).sort({ detectedAt: 1 }).toArray();
  const { usersByIds } = await import('../database/index.js');
  const users = await usersByIds(db.c, page.map((shift) => shift.userId));
  return { items: page.map((shift) => ({
    id: shift._id.toHexString(), memberId: shift.userId, memberName: users.get(shift.userId)?.name ?? 'Staff',
    siteId: shift.siteId.toHexString(), siteName: sites.find((site) => site._id.equals(shift.siteId))?.name ?? 'Site',
    startedAt: shift.startedAt.toISOString(), endedAt: shift.endedAt?.toISOString() ?? null,
    departures: incidents.filter((incident) => incident.shiftId.equals(shift._id)).map((incident) => ({
      detectedAt: incident.detectedAt.toISOString(), confirmedAt: incident.confirmedAt?.toISOString() ?? null,
      returnedAt: incident.returnedAt?.toISOString() ?? null,
    })),
  })), nextCursor: rows.length > input.limit ? page.at(-1)!._id.toHexString() : null };
}
