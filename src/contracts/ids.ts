import { z } from 'zod';

export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Expected a 24-character hexadecimal id');

export const uuidSchema = z.uuid('Expected a UUID');

export const isoDateTimeSchema = z.iso.datetime({ offset: true }).or(z.iso.datetime());
