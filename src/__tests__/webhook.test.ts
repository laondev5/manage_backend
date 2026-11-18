import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyResendSignature } from '../webhooks.js';

const secretBytes = Buffer.from('unit-test-webhook-secret-1234567890');
const secret = `whsec_${secretBytes.toString('base64')}`;

function sign(id: string, timestamp: string, body: string): string {
  return createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
}

describe('Resend webhook verification', () => {
  it('accepts a correctly signed body inside the replay window', () => {
    const body = Buffer.from(JSON.stringify({ type: 'email.delivered' }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign('msg_1', timestamp, body.toString('utf8'));

    expect(
      verifyResendSignature(secret, { id: 'msg_1', timestamp, signature: `v1,${signature}` }, body),
    ).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const body = Buffer.from(JSON.stringify({ type: 'email.delivered' }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign('msg_2', timestamp, body.toString('utf8'));
    const tampered = Buffer.from(JSON.stringify({ type: 'email.bounced' }));

    const result = verifyResendSignature(
      secret,
      { id: 'msg_2', timestamp, signature: `v1,${signature}` },
      tampered,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a stale timestamp outside the five minute window', () => {
    const body = Buffer.from('{}');
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const signature = sign('msg_3', timestamp, body.toString('utf8'));

    const result = verifyResendSignature(
      secret,
      { id: 'msg_3', timestamp, signature: `v1,${signature}` },
      body,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'Webhook timestamp is outside the replay window.',
    });
  });

  it('rejects requests missing signature headers', () => {
    const result = verifyResendSignature(secret, {}, Buffer.from('{}'));
    expect(result.ok).toBe(false);
  });
});
