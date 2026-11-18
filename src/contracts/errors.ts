import { z } from 'zod';

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'MFA_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'INVITATION_INVALID',
  'INVITATION_EXPIRED',
  'SHIFT_ALREADY_ACTIVE',
  'SHIFT_NOT_ACTIVE',
  'STALE_VERSION',
  'SELF_APPROVAL_FORBIDDEN',
  'EXPORT_TOO_LARGE',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const fieldErrorsSchema = z.record(z.string(), z.array(z.string()));

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    fields: fieldErrorsSchema.optional(),
    requestId: z.string(),
  }),
});

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export const requestIdSchema = z.string().uuid();

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly fields?: Record<string, string[]>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const unauthorized = (message = 'Sign in to continue.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have access to this resource.') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found.') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string, code: ErrorCode = 'CONFLICT') =>
  new AppError(409, code, message);

export const validationError = (
  message: string,
  fields?: Record<string, string[]>,
) => new AppError(422, 'VALIDATION_ERROR', message, fields);
