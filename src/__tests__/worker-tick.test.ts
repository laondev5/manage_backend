import { describe, expect, it } from 'vitest';
import { extractBearerToken, verifyWorkerSecret } from '../services/worker-tick.js';

const secret = 'w'.repeat(48);

describe('worker trigger secret', () => {
  it('accepts the exact secret', () => {
    expect(verifyWorkerSecret(secret, secret)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(verifyWorkerSecret(undefined, secret)).toBe(false);
    expect(verifyWorkerSecret('', secret)).toBe(false);
  });

  it('rejects a different secret of the same length', () => {
    expect(verifyWorkerSecret('x'.repeat(48), secret)).toBe(false);
  });

  it('rejects a prefix and an overlong value', () => {
    expect(verifyWorkerSecret(secret.slice(0, 47), secret)).toBe(false);
    expect(verifyWorkerSecret(`${secret}x`, secret)).toBe(false);
  });

  it('refuses to compare against an unset or undersized secret', () => {
    expect(verifyWorkerSecret(secret, undefined)).toBe(false);
    expect(verifyWorkerSecret('short', 'short')).toBe(false);
    expect(verifyWorkerSecret('a'.repeat(31), 'a'.repeat(31))).toBe(false);
  });
});

describe('bearer parsing', () => {
  it('extracts a bearer token case-insensitively', () => {
    expect(extractBearerToken('Bearer abc.def')).toBe('abc.def');
    expect(extractBearerToken('bearer   spaced-token  ')).toBe('spaced-token');
  });

  it('ignores other schemes and empty values', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
  });
});
