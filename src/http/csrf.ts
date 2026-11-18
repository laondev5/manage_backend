import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../contracts/index.js';
import type { Env } from '../env.js';
import { authOf } from './context.js';

export function csrfTokenFor(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url');
}

const safeMethod = (method: string) =>
  method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

export function csrfProtection(env: Env) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (safeMethod(req.method)) return next();
    const origin = req.header('origin');
    const native = req.header('x-manage-client') === 'native';

    if (origin) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        return next(new AppError(403, 'FORBIDDEN', 'The request origin is not allowed.'));
      }
      const localDevPreview =
        !env.isProduction && /^http:\/\/localhost:\d+$/.test(parsed.origin);
      if (!env.trustedWebOrigins.includes(parsed.origin) && !localDevPreview) {
        return next(new AppError(403, 'FORBIDDEN', 'The request origin is not allowed.'));
      }
    }

    if (native || !origin) return next();

    if (!req.auth) {
      return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
    }
    const provided = req.header('x-csrf-token');
    if (!provided) {
      return next(new AppError(403, 'FORBIDDEN', 'A CSRF token is required for this action.'));
    }
    const expected = csrfTokenFor(env.BETTER_AUTH_SECRET, authOf(req).sessionId);
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return next(new AppError(403, 'FORBIDDEN', 'The CSRF token is invalid. Refresh and try again.'));
    }
    return next();
  };
}

export const csrfRoute = (env: Env) => (req: Request, res: Response) => {
  res.json({ token: csrfTokenFor(env.BETTER_AUTH_SECRET, authOf(req).sessionId) });
};
