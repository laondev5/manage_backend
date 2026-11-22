import request from 'supertest';
import type { MailMessage } from '../../mail.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';

const EMAIL = 'reset-flow@example.com';
const UNVERIFIED = 'unverified-resend@example.com';
const CALLBACK = 'http://localhost:3000/reset-password';

describe('password reset and verification email delivery', () => {
  const messages: MailMessage[] = [];
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({}, {
      mailer: {
        provider: 'local',
        async send(message) {
          messages.push(message);
          return { provider: 'local', providerMessageId: `test-${messages.length}` };
        },
      },
    });
    await ctx.createUser(EMAIL);
    // Public sign-up is disabled in the app, so create an unverified account
    // directly to exercise the resend path without sending a sign-up email.
    await ctx.auth.api.signUpEmail({
      body: { name: 'Unverified Person', email: UNVERIFIED, password: 'UnverifiedPass!2026' },
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('sends one reset link, accepts it once, and signs in with the new password', async () => {
    const requested = await request(ctx.app)
      .post('/api/auth/request-password-reset')
      .set('origin', 'http://localhost:3000')
      .send({ email: EMAIL, redirectTo: CALLBACK });
    expect(requested.status).toBe(200);
    expect(requested.body.status).toBe(true);

    const resetMessages = messages.filter((message) => message.to === EMAIL && message.idempotencyKey.startsWith('reset:'));
    expect(resetMessages).toHaveLength(1);
    expect(resetMessages[0]?.subject).toMatch(/reset/i);
    const resetUrl = resetMessages[0]?.text.match(/(https?:\/\/\S+\/api\/auth\/reset-password\/\S+)/)?.[1];
    expect(Boolean(resetUrl)).toBe(true);

    const parsed = new URL(resetUrl!);
    const callback = await request(ctx.app)
      .get(`${parsed.pathname}${parsed.search}`)
      .set('origin', 'http://localhost:3000');
    expect([200, 302]).toContain(callback.status);
    const location = callback.headers.location as string | undefined;
    expect(Boolean(location)).toBe(true);
    const token = new URL(location!).searchParams.get('token');
    expect(Boolean(token)).toBe(true);

    const changed = await request(ctx.app)
      .post('/api/auth/reset-password')
      .set('origin', 'http://localhost:3000')
      .send({ token, newPassword: 'FreshPassword!2026' });
    expect(changed.status).toBe(200);

    const agent = request.agent(ctx.app);
    const signIn = await agent
      .post('/api/auth/sign-in/email')
      .set('origin', 'http://localhost:3000')
      .send({ email: EMAIL, password: 'FreshPassword!2026' });
    expect(signIn.status).toBe(200);
    expect(signIn.body.twoFactorRedirect).toBe(true);

    const replay = await request(ctx.app)
      .post('/api/auth/reset-password')
      .set('origin', 'http://localhost:3000')
      .send({ token, newPassword: 'AnotherPassword!2026' });
    expect(replay.status).not.toBe(200);
  });

  it('sends a single resendable verification email with a usable callback', async () => {
    const sent = await request(ctx.app)
      .post('/api/auth/send-verification-email')
      .set('origin', 'http://localhost:3000')
      .send({ email: UNVERIFIED, callbackURL: 'http://localhost:3000/sign-in' });
    expect(sent.status).toBe(200);

    const verification = messages.filter((message) => message.to === UNVERIFIED && message.idempotencyKey.startsWith('verify:'));
    expect(verification).toHaveLength(1);
    const verifyUrl = verification[0]?.text.match(/(https?:\/\/\S+\/api\/auth\/verify-email\?token=\S+)/)?.[1];
    expect(Boolean(verifyUrl)).toBe(true);
    const parsed = new URL(verifyUrl!);
    expect(parsed.searchParams.get('callbackURL')).toBe('http://localhost:3000/sign-in');
  });
});
