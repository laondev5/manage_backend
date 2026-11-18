import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import {
  createDeliveryContext,
  runWorkerTick,
  type WorkerDeps,
  type WorkerTickResult,
} from '../worker-core/index.js';
import type { AppDeps } from '../http/context.js';

/**
 * Constant-time comparison for the scheduler secret. An unset or short
 * expected value never matches, so a missing production secret cannot be
 * bypassed with an empty header.
 */
export function verifyWorkerSecret(
  provided: string | undefined,
  expected: string | undefined,
): boolean {
  if (!provided || !expected || expected.length < 32) return false;
  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) return undefined;
  return rest.join(' ');
}

export type ScheduledTickOptions = {
  maxItems: number;
  /** Hard stop for new work; leaves headroom before the platform timeout. */
  deadlineMs?: number;
};

export async function runScheduledWorkerTick(
  deps: AppDeps,
  logger: Logger,
  options: ScheduledTickOptions,
): Promise<WorkerTickResult> {
  const delivery = createDeliveryContext({
    env: {
      EMAIL_FROM: deps.env.EMAIL_FROM,
      LOCAL_NOTIFICATION_DIR: deps.env.LOCAL_NOTIFICATION_DIR,
      RESEND_API_KEY: deps.env.RESEND_API_KEY,
      EXPO_ACCESS_TOKEN: deps.env.EXPO_ACCESS_TOKEN,
    },
    c: deps.db.c,
    logger,
    // A serverless filesystem is ephemeral, so never pretend a disk write was a delivery.
    localRoot: deps.env.isProduction ? null : resolve(process.cwd()),
  });

  const workerDeps: WorkerDeps = {
    c: deps.db.c,
    env: deps.env,
    logger,
    delivery,
    workerId: `scheduled-${randomUUID()}`,
  };

  const staleAfterSeconds = Math.max(deps.env.WORKER_SCHEDULE_SECONDS * 2 + 120, 300);
  return runWorkerTick(workerDeps, {
    maxItems: options.maxItems,
    reconcile: true,
    deadlineAt: Date.now() + (options.deadlineMs ?? 20_000),
    heartbeatMode: 'scheduled',
    heartbeatStaleSeconds: staleAfterSeconds,
  });
}
