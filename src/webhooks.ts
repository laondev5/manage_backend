import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { AppError } from './contracts/index.js';
import type { AppDeps } from './http/context.js';

const REPLAY_WINDOW_SECONDS = 5 * 60;

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function parseSignatureHeader(header: string): string[] {
  return header
    .split(' ')
    .map((part) => {
      const [version, value] = part.split(',');
      return version === 'v1' && value ? value : null;
    })
    .filter((value): value is string => Boolean(value));
}

export function verifyResendSignature(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: Buffer,
  now = Date.now(),
): { ok: true; reason?: undefined } | { ok: false; reason: string } {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'Missing webhook signature headers.' };

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'Invalid webhook timestamp.' };
  if (Math.abs(now / 1000 - seconds) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: 'Webhook timestamp is outside the replay window.' };
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  if (key.length === 0) return { ok: false, reason: 'Webhook secret is not configured.' };

  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(rawBody)
    .digest('base64');

  const candidates = parseSignatureHeader(signature);
  const expectedBuffer = Buffer.from(expected);
  const matched = candidates.some((candidate) => {
    const provided = Buffer.from(candidate);
    return provided.length === expectedBuffer.length && timingSafeEqual(provided, expectedBuffer);
  });

  return matched ? { ok: true } : { ok: false, reason: 'Webhook signature does not match.' };
}

type ResendWebhookPayload = {
  type?: string;
  created_at?: string;
  data?: { email_id?: string; to?: string[] | string; subject?: string };
};

const deliveryTypes = new Set([
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
  'email.failed',
]);

export function resendWebhookHandler(deps: AppDeps, logger: Logger): RequestHandler {
  return async (req, res, next) => {
    try {
      const secret = deps.env.RESEND_WEBHOOK_SECRET;
      if (!secret) throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'The email webhook is not configured.');

      const rawBody = req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : null);
      if (!rawBody) {
        throw new AppError(422, 'VALIDATION_ERROR', 'The webhook body could not be read.');
      }

      const verification = verifyResendSignature(
        secret,
        {
          id: req.header('svix-id'),
          timestamp: req.header('svix-timestamp'),
          signature: req.header('svix-signature'),
        },
        rawBody,
      );
      if (!verification.ok) {
        logger.warn({ reason: verification.reason ?? 'unknown' }, 'Rejected Resend webhook');
        throw new AppError(401, 'UNAUTHENTICATED', 'The webhook signature could not be verified.');
      }

      const eventId = req.header('svix-id');
      if (!eventId) throw new AppError(422, 'VALIDATION_ERROR', 'The webhook event id is missing.');

      let payload: ResendWebhookPayload;
      try {
        payload = JSON.parse(rawBody.toString('utf8')) as ResendWebhookPayload;
      } catch {
        throw new AppError(422, 'VALIDATION_ERROR', 'The webhook body is not valid JSON.');
      }

      const eventType = payload.type ?? 'unknown';
      const inserted = await deps.db.c.providerEvents.updateOne(
        { _id: eventId },
        {
          $setOnInsert: {
            provider: 'resend',
            type: eventType,
            eventId,
            receivedAt: new Date(),
            payloadDigest: digest(rawBody),
            processedAt: null,
          },
        },
        { upsert: true },
      );

      if (inserted.upsertedCount === 0) {
        res.json({ ok: true, duplicate: true });
        return;
      }

      const providerMessageId = payload.data?.email_id;
      if (providerMessageId && deliveryTypes.has(eventType)) {
        const now = new Date();
        await deps.db.c.outbox.updateMany(
          { providerMessageId, channel: 'EMAIL' },
          {
            $set: {
              deliveryReportedAt: now,
              updatedAt: now,
              ...(eventType === 'email.bounced' || eventType === 'email.failed'
                ? { lastError: `Provider reported ${eventType}.` }
                : {}),
            },
          },
        );
      }

      await deps.db.c.providerEvents.updateOne(
        { _id: eventId },
        { $set: { processedAt: new Date() } },
      );

      logger.info({ eventId, type: eventType }, 'Processed Resend webhook');
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  };
}
