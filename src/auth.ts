import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { twoFactor } from 'better-auth/plugins';
import { expo } from '@better-auth/expo';
import { ObjectId } from 'mongodb';
import type { Database } from './database/index.js';
import type { Logger } from 'pino';
import type { Env } from './env.js';
import { createMailer, resetPasswordEmail, verificationEmail } from './mail.js';

export function createAuth(db: Database, env: Env, logger: Logger, mailer = createMailer(env, logger)) {

  return betterAuth({
    appName: 'Manage',
    baseURL: env.AUTH_BASE_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: mongodbAdapter(db.db, {
      client: db.client,
      transaction: db.supportsTransactions !== false,
    }),
    trustedOrigins: [
      ...env.trustedWebOrigins,
      `${env.MOBILE_SCHEME}://`,
      `${env.MOBILE_SCHEME}://*`,
      'exp://*',
      ...(env.isProduction ? [] : ['http://localhost:*', 'http://127.0.0.1:*']),
    ],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      async onPasswordReset({ user }) {
        await db.c.users.updateOne({ email: user.email }, { $set: {
          mustChangePassword: false, initialPasswordChanging: false, temporaryPasswordExpiresAt: null,
        } });
      },
      async sendResetPassword({ user, url }) {
        const message = resetPasswordEmail(url);
        await mailer.send({
          to: user.email,
          idempotencyKey: `reset:${user.id}:${Date.now()}`,
          ...message,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      async sendVerificationEmail({ user, url }) {
        const message = verificationEmail(url);
        await mailer.send({
          to: user.email,
          idempotencyKey: `verify:${user.id}:${Date.now()}`,
          ...message,
        });
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    databaseHooks: {
      session: { create: { before: async (session) => {
        const filter = { $or: [{ _id: session.userId }, ...(ObjectId.isValid(session.userId) ? [{ _id: new ObjectId(session.userId) }] : [])] };
        const user = await db.c.users.findOne(filter);
        if (user?.mustChangePassword) {
          const claimed = await db.c.users.findOneAndUpdate({ _id: user._id,
            mustChangePassword: true, temporaryPasswordUsedAt: null,
            temporaryPasswordExpiresAt: { $gt: new Date() },
          }, { $set: { temporaryPasswordUsedAt: new Date() } });
          if (!claimed) return false;
        }
        return { data: session };
      } } },
    },
    advanced: {
      useSecureCookies: env.isProduction,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.isProduction,
        path: '/',
      },
    },
    rateLimit: {
      // Integration tests enroll many users over HTTP in seconds; production and development stay limited.
      enabled: !env.isTest,
      window: 60,
      max: 60,
    },
    plugins: [
      expo(),
      twoFactor({
        issuer: 'Manage',
        skipVerificationOnEnable: false,
      }),
    ],
    telemetry: { enabled: false },
    logger: {
      disabled: !env.isProduction,
      level: 'error',
      log: (level, message, ...args) => {
        logger[level === 'error' ? 'error' : 'warn']({ args }, `auth: ${message}`);
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
