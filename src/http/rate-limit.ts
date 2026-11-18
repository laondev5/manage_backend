import type { Request } from 'express';
import type { Store, Options as RateLimitOptions } from 'express-rate-limit';
import type { Collections } from '../database/index.js';
import { AppError } from '../contracts/index.js';

type IncrementResult = { totalHits: number; resetTime: Date | undefined };

export class MongoRateLimitStore implements Store {
  private readonly c: Collections;
  private windowMs = 60_000;
  prefix: string;

  constructor(c: Collections, prefix: string) {
    this.c = c;
    this.prefix = prefix;
  }

  init(options: RateLimitOptions): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResult> {
    const now = new Date();
    const resetAt = new Date(now.getTime() + this.windowMs);
    const id = `${this.prefix}${key}`;
    const doc = await this.c.rateLimits.findOneAndUpdate(
      { _id: id },
      [
        {
          $set: {
            count: {
              $cond: [{ $lt: ['$resetAt', now] }, 1, { $add: [{ $ifNull: ['$count', 0] }, 1] }],
            },
            resetAt: {
              $cond: [{ $lt: ['$resetAt', now] }, resetAt, '$resetAt'],
            },
          },
        },
      ],
      { upsert: true, returnDocument: 'after' },
    );
    return {
      totalHits: doc?.count ?? 1,
      resetTime: doc?.resetAt ?? resetAt,
    };
  }

  async decrement(key: string): Promise<void> {
    await this.c.rateLimits.updateOne(
      { _id: `${this.prefix}${key}`, count: { $gt: 0 } },
      { $inc: { count: -1 } },
    );
  }

  async resetKey(key: string): Promise<void> {
    await this.c.rateLimits.deleteOne({ _id: `${this.prefix}${key}` });
  }

  async resetAll(): Promise<void> {
    await this.c.rateLimits.deleteMany({ _id: { $regex: `^${this.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } });
  }
}

export const byIp = (req: Request) => req.ip ?? 'unknown';
export const byUserOrIp = (req: Request) => req.auth?.user.id ?? req.ip ?? 'unknown';

export const rateLimitResponse = () => {
  throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Wait a moment and try again.');
};
