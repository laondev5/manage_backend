import { ObjectId } from 'mongodb';
import {
  appendAudit,
  cancelOutboxForIncident,
  heartbeatWorker,
  leaseOutboxItem,
  markOutboxFailed,
  markOutboxSent,
  purgeExpiredLocations,
  type Collections,
  type OutboxDoc,
} from '../database/index.js';
import { deliverEmail, deliverPush, type DeliveryContext } from './delivery.js';

export type WorkerRuntimeEnv = {
  OUTBOX_MAX_ATTEMPTS: number;
  WORKER_LEASE_SECONDS: number;
  PRESENCE_STALE_SECONDS: number;
  STALE_SHIFT_HOURS: number;
  LOCATION_RETENTION_DAYS: number;
};

export type WorkerLoopEnv = WorkerRuntimeEnv & {
  WORKER_RECONCILE_SECONDS: number;
  WORKER_POLL_MS: number;
};

type WorkerLogger = {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
};

export type WorkerDeps<E extends WorkerRuntimeEnv = WorkerRuntimeEnv> = {
  c: Collections;
  env: E;
  logger: WorkerLogger;
  delivery: DeliveryContext;
  workerId: string;
};

export type DrainOptions = {
  maxItems?: number;
  /** Stop leasing new items once this epoch-millisecond deadline passes. */
  deadlineAt?: number;
};

export type DrainResult = {
  delivered: number;
  failed: number;
  deadlineReached: boolean;
  /** The batch was full, so more work is probably waiting. */
  remaining: boolean;
};

export type WorkerTickOptions = {
  maxItems?: number;
  reconcile?: boolean;
  deadlineAt?: number;
  heartbeatMode?: 'loop' | 'scheduled';
  heartbeatStaleSeconds?: number;
};

export type WorkerTickResult = {
  workerId: string;
  startedAt: string;
  durationMs: number;
  delivered: number;
  failed: number;
  remaining: boolean;
  reconciled: boolean;
  presenceReconciled: number;
  staleShiftsFlagged: number;
  locationsPurged: number;
  ok: boolean;
};

export async function processOutboxItem(
  deps: WorkerDeps,
  item: OutboxDoc,
): Promise<void> {
  const { c, env, logger } = deps;

  const alert = await c.alerts.findOne({ _id: item.alertId });
  const incident = alert ? await c.incidents.findOne({ _id: alert.incidentId }) : null;

  if (!alert || !incident || incident.state === 'RETURNED' || incident.state === 'CANCELLED') {
    await c.outbox.updateOne(
      { _id: item._id, state: 'LEASED', leaseOwner: deps.workerId },
      {
        $set: {
          state: 'CANCELLED',
          leaseOwner: null,
          leaseUntil: null,
          lastError: 'The alert was no longer active before delivery.',
          updatedAt: new Date(),
        },
      },
    );
    return;
  }

  try {
    const providerMessageId =
      item.channel === 'EMAIL'
        ? await deliverEmail(deps.delivery, item)
        : await deliverPush(deps.delivery, item);
    const sent = await markOutboxSent(c, item._id, deps.workerId, providerMessageId);
    if (!sent) {
      logger.warn({ outboxId: item._id.toHexString() }, 'Lease expired before the delivery was recorded');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown delivery failure';
    const { dead } = await markOutboxFailed(c, item._id, deps.workerId, message, env.OUTBOX_MAX_ATTEMPTS);
    logger.warn(
      { outboxId: item._id.toHexString(), channel: item.channel, attempts: item.attempts, dead, error: message },
      'Alert delivery failed',
    );
  }
}

export async function drainOutbox(
  deps: WorkerDeps,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const maxItems = Math.max(1, Math.min(100, options.maxItems ?? 20));
  const deadlineAt = options.deadlineAt ?? Date.now() + 30_000;
  let delivered = 0;
  let failed = 0;
  let deadlineReached = false;

  for (let index = 0; index < maxItems; index += 1) {
    if (Date.now() >= deadlineAt) {
      deadlineReached = true;
      break;
    }
    const item = await leaseOutboxItem(
      deps.c,
      deps.workerId,
      deps.env.WORKER_LEASE_SECONDS,
      deps.env.OUTBOX_MAX_ATTEMPTS,
    );
    if (!item) break;
    try {
      await processOutboxItem(deps, item);
      delivered += 1;
    } catch (error) {
      failed += 1;
      deps.logger.error(
        { err: error, outboxId: item._id.toHexString() },
        'Outbox item could not be processed',
      );
    }
  }

  const attempted = delivered + failed;
  return {
    delivered,
    failed,
    deadlineReached,
    remaining: !deadlineReached && attempted >= maxItems,
  };
}

async function cancelCandidateIncident(
  c: Collections,
  shiftId: ObjectId,
  reason: string,
): Promise<void> {
  const incident = await c.incidents.findOne({ shiftId, state: 'CANDIDATE', open: true });
  if (!incident) return;
  const now = new Date();
  await c.incidents.updateOne(
    { _id: incident._id, state: 'CANDIDATE' },
    {
      $set: {
        state: 'CANCELLED',
        open: false,
        cancelledAt: now,
        cancelledReason: reason,
        updatedAt: now,
      },
    },
  );
  await cancelOutboxForIncident(c, incident._id);
}

export async function reconcilePresence(deps: WorkerDeps): Promise<number> {
  const { c, env } = deps;
  const freshnessCutoff = new Date(Date.now() - env.PRESENCE_STALE_SECONDS * 1000);
  const stale = await c.shifts
    .find({
      status: 'WORKING',
      'presence.state': { $ne: 'UNKNOWN' },
      $or: [
        { 'presence.lastQualifiedAt': { $lt: freshnessCutoff } },
        { 'presence.lastQualifiedAt': null },
      ],
    })
    .limit(200)
    .toArray();

  for (const shift of stale) {
    await c.shifts.updateOne(
      { _id: shift._id, status: 'WORKING' },
      {
        $set: {
          'presence.state': 'UNKNOWN',
          'presence.candidateSince': null,
          'presence.updatedAt': new Date(),
          updatedAt: new Date(),
        },
      },
    );
    await cancelCandidateIncident(
      c,
      shift._id,
      'Location evidence went stale before a departure could be confirmed.',
    );
  }

  return stale.length;
}

export async function reconcileStaleShifts(deps: WorkerDeps): Promise<number> {
  const { c, env, logger } = deps;
  const cutoff = new Date(Date.now() - env.STALE_SHIFT_HOURS * 60 * 60 * 1000);
  const shifts = await c.shifts
    .find({
      status: 'WORKING',
      lastSyncAt: { $lt: cutoff },
      $or: [{ staleFlaggedAt: null }, { staleFlaggedAt: { $exists: false } }],
    })
    .limit(200)
    .toArray();

  let flagged = 0;
  for (const shift of shifts) {
    const now = new Date();
    const updated = await c.shifts.updateOne(
      { _id: shift._id, status: 'WORKING', staleFlaggedAt: null },
      {
        $set: {
          staleFlaggedAt: now,
          reviewState: shift.reviewState === 'ACCEPTED' ? 'NEEDS_REVIEW' : shift.reviewState,
          reviewReason:
            shift.reviewReason ??
            `No sync received for more than ${env.STALE_SHIFT_HOURS} hours. The shift remains open for review.`,
          'presence.state': 'UNKNOWN',
          'presence.candidateSince': null,
          updatedAt: now,
        },
      },
    );
    if (updated.modifiedCount === 0) continue;

    flagged += 1;
    await cancelCandidateIncident(
      c,
      shift._id,
      'The shift stopped syncing before a departure could be confirmed.',
    );
    await appendAudit(c, {
      actorId: null,
      actorName: 'System worker',
      actorRole: 'SYSTEM',
      action: 'shift.stale_flagged',
      targetType: 'shift',
      targetId: shift._id.toHexString(),
      organizationId: shift.organizationId,
      siteId: shift.siteId,
      summary: 'Flagged a working shift with no recent sync for review',
    });
    logger.info({ shiftId: shift._id.toHexString() }, 'Flagged stale working shift');
  }

  return flagged;
}

/**
 * One bounded unit of worker work. Safe to invoke from a long-running loop or
 * from a scheduled HTTP request: deliveries are fenced by Mongo leases, the
 * deadline stops new work, and per-item failures never abort the batch.
 */
export async function runWorkerTick(
  deps: WorkerDeps,
  options: WorkerTickOptions = {},
): Promise<WorkerTickResult> {
  const startedAt = new Date();
  const startedMs = startedAt.getTime();
  const deadlineAt = options.deadlineAt ?? startedMs + 30_000;
  const mode = options.heartbeatMode ?? 'loop';
  const staleSeconds = options.heartbeatStaleSeconds ?? 60;
  let ok = true;
  let delivered = 0;
  let failed = 0;
  let remaining = false;
  let reconciled = false;
  let presenceReconciled = 0;
  let staleShiftsFlagged = 0;
  let locationsPurged = 0;

  try {
    await heartbeatWorker(deps.c, deps.workerId, 'working', {
      mode,
      staleAfterSeconds: staleSeconds,
    });

    const drain = await drainOutbox(deps, {
      maxItems: options.maxItems ?? 20,
      deadlineAt,
    });
    delivered = drain.delivered;
    failed = drain.failed;
    remaining = drain.remaining;

    if (options.reconcile && Date.now() < deadlineAt) {
      presenceReconciled = await reconcilePresence(deps);
      staleShiftsFlagged = await reconcileStaleShifts(deps);
      const retentionCutoff = new Date(
        Date.now() - deps.env.LOCATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
      const purged = await purgeExpiredLocations(deps.c, retentionCutoff);
      locationsPurged = purged.observations + purged.events + purged.incidents;
      reconciled = true;
    }
  } catch (error) {
    ok = false;
    deps.logger.error({ err: error }, 'Worker tick failed');
  } finally {
    try {
      await heartbeatWorker(deps.c, deps.workerId, 'idle', {
        mode,
        staleAfterSeconds: staleSeconds,
      });
    } catch (error) {
      ok = false;
      deps.logger.error({ err: error }, 'Worker heartbeat could not be recorded');
    }
  }

  return {
    workerId: deps.workerId,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    delivered,
    failed,
    remaining,
    reconciled,
    presenceReconciled,
    staleShiftsFlagged,
    locationsPurged,
    ok,
  };
}

export class ManageWorker {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private lastReconcileAt = 0;

  constructor(private readonly deps: WorkerDeps<WorkerLoopEnv>) {}

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const reconcile =
        now - this.lastReconcileAt >= this.deps.env.WORKER_RECONCILE_SECONDS * 1000;
      const result = await runWorkerTick(this.deps, {
        reconcile,
        maxItems: 20,
        deadlineAt: now + 50_000,
        heartbeatMode: 'loop',
        heartbeatStaleSeconds: 90,
      });
      if (result.reconciled) this.lastReconcileAt = Date.now();
    } finally {
      this.ticking = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.env.WORKER_POLL_MS);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
