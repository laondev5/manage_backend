import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import type { Env } from './env.js';
import { projectRoot } from './load-env.js';

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

export type MailResult = {
  provider: 'resend' | 'local';
  providerMessageId: string;
};

export type Mailer = ReturnType<typeof createMailer>;

export function createMailer(env: Env, logger: { info: (obj: object, msg?: string) => void }) {
  const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
  const directory = resolve(projectRoot, env.LOCAL_NOTIFICATION_DIR, 'mail');

  return {
    provider: env.emailProvider,
    async send(message: MailMessage): Promise<MailResult> {
      if (resend) {
        // The SDK's second argument sets the HTTP idempotency header. Payload
        // headers are email headers and do not deduplicate API requests.
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await resend.emails.send({
            from: env.EMAIL_FROM, to: message.to, subject: message.subject,
            html: message.html, text: message.text,
            // Transactional mail should not generate out-of-office replies.
            headers: { 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
          }, { idempotencyKey: message.idempotencyKey });
          if (!result.error && result.data?.id) {
            return { provider: 'resend', providerMessageId: result.data.id };
          }
          const status = result.error?.statusCode ?? 0;
          const code = result.error?.name ?? 'missing_message_id';
          const transient = code === 'rate_limit_exceeded' || code === 'application_error' || status >= 500;
          // Never log provider messages: they can contain recipient addresses.
          logger.info({ provider: 'resend', status, code, attempt: attempt + 1 }, 'Email provider rejected a send');
          if (!transient || attempt === 2) throw new Error(`Email provider failure (${code}, ${status}).`);
          const retryAfter = Number(result.headers?.['retry-after']);
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
          if (delay > 5000) throw new Error(`Email provider retry window too long (${code}).`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        throw new Error('Email provider retry limit reached.');
      }

      await mkdir(directory, { recursive: true });
      const id = `local-${randomUUID()}`;
      const path = join(directory, `${Date.now()}-${id}.json`);
      await writeFile(
        path,
        JSON.stringify(
          {
            id,
            to: message.to,
            from: env.EMAIL_FROM,
            subject: message.subject,
            html: message.html,
            text: message.text,
            createdAt: new Date().toISOString(),
            note: 'Local development adapter. This message was written to disk, not delivered by an email provider.',
          },
          null,
          2,
        ),
        'utf8',
      );
      logger.info({ path, id }, 'Local email adapter wrote a message');
      return { provider: 'local', providerMessageId: id };
    },
  };
}

export const verificationEmail = (url: string) => ({
  subject: 'Confirm your Manage email address',
  text: `Open this link to confirm your Manage email address.\n\n${url}\n\nThis link expires in one hour.`,
  html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F5F7FB;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E3E8F1;border-radius:16px;padding:32px">
    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#2457D6;text-transform:uppercase">Manage</div>
    <h1 style="font-size:24px;color:#14213D;margin:12px 0 8px">Verify your email</h1>
    <p style="color:#526078;line-height:1.6">Confirm this email address to finish setting up your Manage account.</p>
    <a href="${url}" style="display:inline-block;margin-top:20px;background:#2457D6;color:#fff;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:600">Verify email</a>
    <p style="color:#7C89A0;font-size:12px;margin-top:24px">This link expires in one hour. If you did not request it, you can ignore this message.</p>
  </div>
</div>`,
});

/**
 * One actionable message for an administrator/owner-created account. The
 * verification link proves ownership of the address, and the temporary
 * password is included so the recipient never has to hunt for a second mail.
 */
export const accountSetupEmail = (args: {
  name: string;
  email: string;
  temporaryPassword: string;
  verifyUrl: string;
  signInUrl: string;
}) => {
  const { name, email, temporaryPassword, verifyUrl, signInUrl } = args;
  return {
    subject: 'Your Manage account is ready',
    text: `Hi ${name},

Your Manage account is ready. Complete both steps below.

1. Confirm your email address
${verifyUrl}

2. Sign in
${signInUrl}
Email: ${email}
Sign-in code: ${temporaryPassword}

Manage will ask you to choose a new password when you sign in. The sign-in code expires in 24 hours. If it expires, use Forgot password on the sign-in screen.

If you were not expecting this account, contact your administrator.`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F5F7FB;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E3E8F1;border-radius:16px;padding:32px">
    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#2457D6;text-transform:uppercase">Manage</div>
    <h1 style="font-size:24px;color:#14213D;margin:12px 0 8px">Your account is ready</h1>
    <p style="color:#526078;line-height:1.6">Hi ${name}, your account is ready. Complete both steps below.</p>
    <p style="color:#14213D;font-weight:700;margin-top:24px">1. Confirm your email address</p>
    <a href="${verifyUrl}" style="display:inline-block;margin-top:10px;background:#2457D6;color:#fff;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:600">Confirm email</a>
    <p style="color:#7C89A0;font-size:12px;line-height:1.5;margin-top:8px">If the button does not work, copy this link into your browser:<br/>${verifyUrl}</p>
    <p style="color:#14213D;font-weight:700;margin-top:24px">2. Sign in</p>
    <p style="color:#526078;line-height:1.6;margin-top:8px">Sign in at <a href="${signInUrl}" style="color:#2457D6">${signInUrl}</a> using:</p>
    <p style="background:#F5F7FB;border:1px solid #E3E8F1;border-radius:10px;padding:12px 14px;color:#14213D;line-height:1.7">Email: <strong>${email}</strong><br/>Sign-in code: <strong style="letter-spacing:.02em">${temporaryPassword}</strong></p>
    <p style="color:#526078;line-height:1.6;margin-top:16px">Manage will ask you to choose a new password when you sign in.</p>
    <p style="color:#7C89A0;font-size:12px;margin-top:16px">The sign-in code expires in 24 hours. If it expires, use Forgot password on the sign-in screen. If you did not expect this account, contact your administrator.</p>
  </div>
</div>`,
  };
};

export const resetPasswordEmail = (url: string) => ({
  subject: 'Manage password reset link',
  text: `Reset your Manage password using this link:\n\n${url}\n\nThis link expires in one hour. Resetting your password signs out other sessions.`,
  html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F5F7FB;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E3E8F1;border-radius:16px;padding:32px">
    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#2457D6;text-transform:uppercase">Manage</div>
    <h1 style="font-size:24px;color:#14213D;margin:12px 0 8px">Reset your password</h1>
    <p style="color:#526078;line-height:1.6">Use the button below to choose a new password. For your security, other sessions will be signed out.</p>
    <a href="${url}" style="display:inline-block;margin-top:20px;background:#2457D6;color:#fff;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:600">Reset password</a>
    <p style="color:#7C89A0;font-size:12px;margin-top:24px">This link expires in one hour. If you did not request it, no change has been made.</p>
  </div>
</div>`,
});

export const invitationEmail = (siteName: string, inviterName: string, url: string) => ({
  subject: `You are invited to ${siteName} on Manage`,
  text: `${inviterName} invited you to clock in at ${siteName}.\n\nAccept the invitation and set your password:\n${url}\n\nThis invitation is single use and expires in 7 days.`,
  html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F5F7FB;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E3E8F1;border-radius:16px;padding:32px">
    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#2457D6;text-transform:uppercase">Manage</div>
    <h1 style="font-size:24px;color:#14213D;margin:12px 0 8px">You are invited to ${siteName}</h1>
    <p style="color:#526078;line-height:1.6">${inviterName} invited you to record attendance at ${siteName}.</p>
    <a href="${url}" style="display:inline-block;margin-top:20px;background:#2457D6;color:#fff;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:600">Accept invitation</a>
    <p style="color:#7C89A0;font-size:12px;margin-top:24px">This invitation is single use and expires in 7 days.</p>
  </div>
</div>`,
});

export const teamInvitationEmail = (organizationName: string, inviterName: string, url: string) => ({
  subject: `You are invited to join ${organizationName} on Manage`,
  text: `${inviterName} invited you to join the ${organizationName} team on Manage.\n\nAccept the invitation and set your password:\n${url}\n\nThis invitation is single use and expires in 7 days. A site owner can assign you to a site afterwards.`,
  html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F5F7FB;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E3E8F1;border-radius:16px;padding:32px">
    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#2457D6;text-transform:uppercase">Manage</div>
    <h1 style="font-size:24px;color:#14213D;margin:12px 0 8px">Join ${organizationName}</h1>
    <p style="color:#526078;line-height:1.6">${inviterName} invited you to join the ${organizationName} team on Manage. A site owner can assign you to a site once you sign in.</p>
    <a href="${url}" style="display:inline-block;margin-top:20px;background:#2457D6;color:#fff;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:600">Accept invitation</a>
    <p style="color:#7C89A0;font-size:12px;margin-top:24px">This invitation is single use and expires in 7 days.</p>
  </div>
</div>`,
});

export const alertEmail = (siteName: string, opaqueId: string) => ({
  subject: 'Manage alert: an on-duty worker may have left the site',
  text: `An on-duty worker may have left ${siteName}. Open Manage to see the detail and review the alert.\n\nReference: ${opaqueId}\n\nLocation readings can be imperfect. A departure alert is a prompt to review, not a disciplinary decision.`,
  html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#F5F7FB;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E3E8F1;border-radius:16px;padding:32px">
    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#2457D6;text-transform:uppercase">Manage</div>
    <h1 style="font-size:24px;color:#14213D;margin:12px 0 8px">Possible departure at ${siteName}</h1>
    <p style="color:#526078;line-height:1.6">An on-duty worker&rsquo;s device was detected outside the site boundary. Open the alert in Manage for the detected time, last update, and review actions.</p>
    <p style="color:#7C89A0;font-size:13px;margin-top:16px">Location readings can be imperfect. This alert is a prompt to review, not a disciplinary decision.</p>
  </div>
</div>`,
});
