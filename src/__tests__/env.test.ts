import { describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';

const productionBase = {
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: 's'.repeat(48),
  AUTH_BASE_URL: 'https://api.example.com',
  RESEND_API_KEY: 're_test',
  RESEND_WEBHOOK_SECRET: 'wh_test',
  WORKER_TRIGGER_SECRET: 'w'.repeat(48),
};

describe('production trusted web origins', () => {
  it('accepts HTTPS origins', () => {
    const env = loadEnv({ ...productionBase, TRUSTED_WEB_ORIGINS: 'https://console.example.com' });
    expect(env.trustedWebOrigins).toEqual(['https://console.example.com']);
  });

  it('accepts loopback HTTP origins for local consoles against a hosted API', () => {
    const env = loadEnv({
      ...productionBase,
      TRUSTED_WEB_ORIGINS: 'https://console.example.com, http://localhost:3000,http://127.0.0.1:3000,http://[::1]:3000',
    });
    expect(env.trustedWebOrigins).toHaveLength(4);
  });

  it('rejects non-loopback HTTP origins', () => {
    expect(() =>
      loadEnv({ ...productionBase, TRUSTED_WEB_ORIGINS: 'http://console.example.com' }),
    ).toThrow(/must use HTTPS in production/);
    expect(() =>
      loadEnv({ ...productionBase, TRUSTED_WEB_ORIGINS: 'http://192.168.1.10:3000' }),
    ).toThrow(/must use HTTPS in production/);
  });

  it('rejects malformed origins', () => {
    expect(() =>
      loadEnv({ ...productionBase, TRUSTED_WEB_ORIGINS: 'localhost:3000' }),
    ).toThrow(/must use HTTPS in production/);
  });

  it('allows any origin scheme outside production', () => {
    const env = loadEnv({
      NODE_ENV: 'development',
      BETTER_AUTH_SECRET: 's'.repeat(48),
      TRUSTED_WEB_ORIGINS: 'http://localhost:3000',
    });
    expect(env.trustedWebOrigins).toEqual(['http://localhost:3000']);
  });
});