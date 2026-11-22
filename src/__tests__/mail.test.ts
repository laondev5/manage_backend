import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../env.js';
import { createMailer } from '../mail.js';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({ Resend: class { emails = { send }; } }));
const message = { to: 'test@example.com', subject: 'Test', text: 'Sensitive test body', html: '<p>Test</p>', idempotencyKey: 'account-password:test' };
const env = loadEnv({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://localhost:27017/test', BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret', RESEND_API_KEY: 'test-only-key' });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
describe('email provider reliability', () => {
  it('retries rate limits using the same HTTP idempotency key without logging the body', async () => {
    vi.useFakeTimers(); const info = vi.fn();
    send.mockResolvedValueOnce({ data: null, error: { name: 'rate_limit_exceeded', statusCode: 429 }, headers: { 'retry-after': '1' } })
      .mockResolvedValueOnce({ data: { id: 'provider-id' }, error: null });
    const pending = createMailer(env, { info }).send(message);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ provider: 'resend', providerMessageId: 'provider-id' });
    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      expect(call[1]).toEqual({ idempotencyKey: message.idempotencyKey });
      expect(call[0].headers).toEqual({ 'X-Auto-Response-Suppress': 'OOF, AutoReply' });
    }
    expect(JSON.stringify(info.mock.calls)).not.toContain(message.text);
    expect(JSON.stringify(info.mock.calls)).not.toContain(message.to);
  });
  it.each(['validation_error', 'daily_quota_exceeded', 'monthly_quota_exceeded'])('does not retry permanent rejection %s', async (name) => {
    send.mockResolvedValue({ data: null, error: { name, statusCode: name === 'validation_error' ? 422 : 429 } });
    await expect(createMailer(env, { info: vi.fn() }).send(message)).rejects.toThrow('Email provider failure');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('bounds retries when the provider remains unavailable', async () => {
    vi.useFakeTimers(); send.mockResolvedValue({ data: null, error: { name: 'internal_server_error', statusCode: 500 } });
    const assertion = expect(createMailer(env, { info: vi.fn() }).send(message)).rejects.toThrow('Email provider failure');
    await vi.runAllTimersAsync(); await assertion;
    expect(send).toHaveBeenCalledTimes(3);
  });
});
