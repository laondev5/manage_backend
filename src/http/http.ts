import type { ErrorRequestHandler, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AppError, type ApiErrorBody } from '../contracts/index.js';
import type { Logger } from 'pino';
import { zodToValidationError } from './context.js';

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && incoming.length <= 100 ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, _next) => {
    let status = 500;
    let code: ApiErrorBody['error']['code'] = 'INTERNAL_ERROR';
    let message = 'Something went wrong. Try again.';
    let fields: Record<string, string[]> | undefined;

    if (error instanceof AppError) {
      status = error.status;
      code = error.code;
      message = error.message;
      fields = error.fields;
    } else if (error instanceof ZodError) {
      const converted = zodToValidationError(error);
      status = converted.status;
      code = converted.code;
      message = converted.message;
      fields = converted.fields;
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    ) {
      status = 409;
      code = 'CONFLICT';
      message = 'That action conflicts with an existing record.';
    } else if (
      typeof error === 'object' &&
      error !== null &&
      (error as { type?: string }).type === 'entity.parse.failed'
    ) {
      status = 422;
      code = 'VALIDATION_ERROR';
      message = 'The request body is not valid JSON.';
    }

    if (status >= 500) {
      logger.error({ err: error, requestId: req.requestId }, 'Unhandled request error');
    }

    const body: ApiErrorBody = {
      error: {
        code,
        message,
        ...(fields ? { fields } : {}),
        requestId: req.requestId,
      },
    };
    res.status(status).json(body);
  };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ApiErrorBody = {
    error: {
      code: 'NOT_FOUND',
      message: 'Resource not found.',
      requestId: req.requestId,
    },
  };
  res.status(404).json(body);
};
