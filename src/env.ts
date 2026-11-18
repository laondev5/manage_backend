import { z } from 'zod';

const booleanString = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().min(10).default('mongodb://127.0.0.1:27017/manage?replicaSet=rs0'),
  MONGODB_DB_NAME: z.string().min(1).default('manage'),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters.'),
  AUTH_BASE_URL: z.string().url().default('http://localhost:4000'),
  TRUSTED_WEB_ORIGINS: z.string().default('http://localhost:3000'),
  MOBILE_SCHEME: z.string().min(2).default('manage'),
  WORKER_TRIGGER_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  WORKER_SCHEDULE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(300),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  EMAIL_FROM: z.string().default('Manage <alerts@manage.local>'),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  LOCAL_NOTIFICATION_DIR: z.string().default('.notifications'),
  ENABLE_DEV_TOKENS: booleanString,
  TRUST_PROXY: booleanString,
  LOCATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  STALE_SHIFT_HOURS: z.coerce.number().int().min(1).max(72).default(16),
  PRESENCE_STALE_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  SEED_PASSWORD: z.string().min(12).default('ManageDemo!2026'),
});

export type Env = z.infer<typeof envSchema> & {
  isProduction: boolean;
  isTest: boolean;
  isVercel: boolean;
  trustedWebOrigins: string[];
  emailProvider: 'resend' | 'local';
  pushProvider: 'expo' | 'local';
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const value = parsed.data;
  const isProduction = value.NODE_ENV === 'production';
  const isTest = value.NODE_ENV === 'test';
  const isVercel = source.VERCEL === '1';
  const trustedWebOrigins = value.TRUSTED_WEB_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (isProduction) {
    if (!value.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is required in production; local delivery is development-only.');
    }
    if (!value.RESEND_WEBHOOK_SECRET) {
      throw new Error('RESEND_WEBHOOK_SECRET is required in production.');
    }
    if (value.ENABLE_DEV_TOKENS) {
      throw new Error('ENABLE_DEV_TOKENS must not be enabled in production.');
    }
    if (!value.CRON_SECRET && !value.WORKER_TRIGGER_SECRET) {
      throw new Error(
        'CRON_SECRET (Vercel Cron) or WORKER_TRIGGER_SECRET (external scheduler) must be at least 32 characters in production so the scheduled worker can drain the outbox.',
      );
    }
    if (value.CRON_SECRET && value.CRON_SECRET.length < 32) {
      throw new Error('CRON_SECRET must be at least 32 characters.');
    }
    if (value.WORKER_TRIGGER_SECRET && value.WORKER_TRIGGER_SECRET.length < 32) {
      throw new Error('WORKER_TRIGGER_SECRET must be at least 32 characters.');
    }
    if (!value.AUTH_BASE_URL.startsWith('https://')) {
      throw new Error('AUTH_BASE_URL must use HTTPS in production.');
    }
    for (const origin of trustedWebOrigins) {
      // Loopback origins never leave the machine, so a local console may talk
      // to a hosted API over HTTP; every other origin must use HTTPS.
      if (!origin.startsWith('https://') && !isLoopbackOrigin(origin)) {
        throw new Error(`Trusted web origin must use HTTPS in production: ${origin}`);
      }
    }
  }

  return {
    ...value,
    isProduction,
    isTest,
    isVercel,
    trustedWebOrigins,
    emailProvider: value.RESEND_API_KEY ? 'resend' : 'local',
    pushProvider: value.EXPO_ACCESS_TOKEN ? 'expo' : 'local',
  };
}
