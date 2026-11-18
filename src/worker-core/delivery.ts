import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { Resend } from 'resend';
import type { Collections, OutboxDoc } from '../database/index.js';

type DeliveryLogger = {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
};

export type DeliveryEnv = {
  EMAIL_FROM: string;
  LOCAL_NOTIFICATION_DIR: string;
  RESEND_API_KEY?: string;
  EXPO_ACCESS_TOKEN?: string;
};

export type DeliveryContext = {
  env: DeliveryEnv;
  c: Collections;
  logger: DeliveryLogger;
  resend: Resend | null;
  /**
   * Base directory for the disk adapter. `null` disables the adapter so a
   * serverless instance never reports a delivery that only landed in a
   * discarded filesystem.
   */
  localRoot: string | null;
};

export function createDeliveryContext(options: {
  env: DeliveryEnv;
  c: Collections;
  logger: DeliveryLogger;
  localRoot: string | null;
}): DeliveryContext {
  return {
    env: options.env,
    c: options.c,
    logger: options.logger,
    resend: options.env.RESEND_API_KEY ? new Resend(options.env.RESEND_API_KEY) : null,
    localRoot: options.localRoot,
  };
}

function localDirectory(ctx: DeliveryContext, channel: 'mail' | 'push'): string {
  if (!ctx.localRoot) {
    throw new Error(
      'No notification provider is configured and the local disk adapter is disabled in this environment.',
    );
  }
  return resolve(ctx.localRoot, ctx.env.LOCAL_NOTIFICATION_DIR, channel);
}

async function resolveRecipient(c: Collections, recipientId: string) {
  const user = await c.users.findOne({
    $or: [{ _id: recipientId }, { _id: new ObjectId(recipientId) }],
  } as never);
  return user ?? null;
}

async function alertCopy(c: Collections, item: OutboxDoc) {
  const alert = await c.alerts.findOne({ _id: item.alertId });
  const site = alert ? await c.sites.findOne({ _id: alert.siteId }) : null;
  return {
    alert,
    siteName: site?.name ?? 'your site',
    opaqueId: item.alertId.toHexString(),
  };
}

const alertHtml = (siteName: string, opaqueId: string) => `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F5F7FB;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E3E8F1;border-radius:16px;padding:32px">
    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#2457D6;text-transform:uppercase">Manage</div>
    <h1 style="font-size:24px;color:#14213D;margin:12px 0 8px">Possible departure at ${siteName}</h1>
    <p style="color:#526078;line-height:1.6">An on-duty worker&rsquo;s device was detected outside the site boundary. Open Manage for the detected time, last update, and review actions.</p>
    <p style="color:#7C89A0;font-size:13px;margin-top:16px">Location readings can be imperfect. This alert is a prompt to review, not a disciplinary decision.</p>
    <p style="color:#7C89A0;font-size:12px;margin-top:12px">Reference: ${opaqueId}</p>
  </div>
</div>`;

const alertText = (siteName: string, opaqueId: string) =>
  `An on-duty worker may have left ${siteName}. Open Manage to see the detail and review the alert.\n\nReference: ${opaqueId}\n\nLocation readings can be imperfect. A departure alert is a prompt to review, not a disciplinary decision.`;

export async function deliverEmail(ctx: DeliveryContext, item: OutboxDoc): Promise<string> {
  const recipient = await resolveRecipient(ctx.c, item.recipientId);
  if (!recipient) throw new Error('The alert recipient no longer exists.');

  const { siteName, opaqueId } = await alertCopy(ctx.c, item);
  const subject = 'Manage alert: an on-duty worker may have left the site';

  if (ctx.resend) {
    const result = await ctx.resend.emails.send({
      from: ctx.env.EMAIL_FROM,
      to: recipient.email,
      subject,
      html: alertHtml(siteName, opaqueId),
      text: alertText(siteName, opaqueId),
      headers: { 'Idempotency-Key': item.logicalKey },
    });
    if (result.error) throw new Error(`Resend rejected the message: ${result.error.message}`);
    if (!result.data?.id) throw new Error('Resend did not return a message id.');
    return result.data.id;
  }

  const directory = localDirectory(ctx, 'mail');
  await mkdir(directory, { recursive: true });
  const id = `local-${randomUUID()}`;
  await writeFile(
    join(directory, `${Date.now()}-${id}.json`),
    JSON.stringify(
      {
        id,
        kind: 'alert-email',
        to: recipient.email,
        from: ctx.env.EMAIL_FROM,
        subject,
        text: alertText(siteName, opaqueId),
        alertId: opaqueId,
        logicalKey: item.logicalKey,
        createdAt: new Date().toISOString(),
        note: 'Local development adapter. This message was written to disk, not delivered by an email provider.',
      },
      null,
      2,
    ),
    'utf8',
  );
  ctx.logger.info({ id }, 'Local email adapter wrote an alert message');
  return id;
}

type ExpoTicket = { status?: string; id?: string; message?: string; details?: { error?: string } };

export async function deliverPush(ctx: DeliveryContext, item: OutboxDoc): Promise<string> {
  const devices = await ctx.c.devices
    .find({ userId: item.recipientId, pushEnabled: true, revokedAt: null, pushToken: { $ne: null } })
    .toArray();
  const tokens = devices
    .map((device) => device.pushToken)
    .filter((token): token is string => Boolean(token));

  if (tokens.length === 0) {
    ctx.logger.info({ recipientId: item.recipientId }, 'No push devices registered; skipping push');
    return 'no-devices';
  }

  const { siteName, opaqueId } = await alertCopy(ctx.c, item);
  const message = {
    title: 'Possible departure',
    body: `An on-duty worker may have left ${siteName}. Open Manage to review.`,
    data: {
      type: 'departure-alert',
      alertId: opaqueId,
      incidentId: item.incidentId.toHexString(),
    },
    sound: 'default',
    priority: 'high',
  };

  if (ctx.env.EXPO_ACCESS_TOKEN) {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.env.EXPO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tokens.map((token) => ({ to: token, ...message }))),
    });
    if (!response.ok) {
      throw new Error(`Expo push returned HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as { data?: ExpoTicket[] };
    const tickets = payload.data ?? [];
    const delivered = tickets.filter((ticket) => ticket.status === 'ok' && ticket.id);
    if (delivered.length === 0) {
      const reason = tickets.find((ticket) => ticket.message)?.message ?? 'Expo rejected every push ticket.';
      throw new Error(reason);
    }
    await Promise.all(
      tickets.map(async (ticket, index) => {
        if (ticket.details?.error === 'DeviceNotRegistered') {
          const token = tokens[index];
          if (token) {
            await ctx.c.devices.updateOne(
              { pushToken: token },
              { $set: { pushEnabled: false, updatedAt: new Date() } },
            );
          }
        }
      }),
    );
    return delivered.map((ticket) => ticket.id).join(',');
  }

  const directory = localDirectory(ctx, 'push');
  await mkdir(directory, { recursive: true });
  const id = `local-push-${randomUUID()}`;
  await writeFile(
    join(directory, `${Date.now()}-${id}.json`),
    JSON.stringify(
      {
        id,
        kind: 'alert-push',
        recipientId: item.recipientId,
        tokens,
        ...message,
        logicalKey: item.logicalKey,
        createdAt: new Date().toISOString(),
        note: 'Local development adapter. This notification was written to disk, not delivered by Expo.',
      },
      null,
      2,
    ),
    'utf8',
  );
  return id;
}
