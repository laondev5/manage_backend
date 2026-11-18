import { z } from 'zod';

const booleanString = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MONGODB_URI: z.string().min(10).default('mongodb://127.0.0.1:27017/manage?replicaSet=rs0'),
  MONGODB_DB_NAME: z.string().min(1).default('manage'),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Manage <alerts@manage.local>'),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  LOCAL_NOTIFICATION_DIR: z.string().default('.data/notifications'),
  WORKER_POLL_MS: z.coerce.number().int().min(500).max(60_000).default(3_000),
  WORKER_RECONCILE_SECONDS: z.coerce.number().int().min(10).max(900).default(45),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
  PRESENCE_STALE_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  STALE_SHIFT_HOURS: z.coerce.number().int().min(1).max(72).default(16),
  LOCATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  TRUST_PROXY: booleanString,
});

export type WorkerEnv = z.infer<typeof schema> & {
  isProduction: boolean;
  emailProvider: 'resend' | 'local';
  pushProvider: 'expo' | 'local';
};

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid worker environment configuration:\n${issues}`);
  }
  const value = parsed.data;
  const isProduction = value.NODE_ENV === 'production';
  if (isProduction && !value.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is required in production; local delivery is development-only.');
  }
  return {
    ...value,
    isProduction,
    emailProvider: value.RESEND_API_KEY ? 'resend' : 'local',
    pushProvider: value.EXPO_ACCESS_TOKEN ? 'expo' : 'local',
  };
}
