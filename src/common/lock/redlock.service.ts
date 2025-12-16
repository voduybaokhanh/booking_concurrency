import { ConflictException, Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { envNumber } from '../config/env';

interface LockResult {
  token: string;
  validityTime: number;
}

@Injectable()
export class RedlockService implements OnModuleDestroy {
  private readonly clients: Redis[];
  private readonly quorum: number;
  private readonly driftFactor: number;
  private readonly retryCount: number;
  private readonly retryDelayMs: number;
  private readonly logger = new Logger(RedlockService.name);

  constructor() {
    const urls = process.env.REDIS_URLS?.split(',') || [process.env.REDIS_URL || 'redis://localhost:6379'];
    this.clients = urls.map((url) => new Redis(url.trim()));
    this.quorum = Math.floor(this.clients.length / 2) + 1;
    this.driftFactor = envNumber('REDLOCK_DRIFT_FACTOR', 0.01);
    this.retryCount = envNumber('REDLOCK_RETRY_COUNT', 3);
    this.retryDelayMs = envNumber('REDLOCK_RETRY_DELAY_MS', 200);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.quit()));
  }

  private async acquireLockOnInstance(client: Redis, key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await client.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  private async releaseLockOnInstance(client: Redis, key: string, token: string): Promise<boolean> {
    const script =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
    const result = await client.eval(script, 1, key, token);
    return result === 1;
  }

  async acquireLock(key: string, ttlMs: number): Promise<LockResult> {
    const token = randomUUID();
    const startTime = Date.now();
    const validityTime = ttlMs - Math.floor(ttlMs * this.driftFactor) - (Date.now() - startTime);

    if (validityTime <= 0) {
      throw new ConflictException('Lock TTL too short for Redlock');
    }

    let attempt = 0;
    while (attempt < this.retryCount) {
      const acquired = await Promise.all(
        this.clients.map((client) => this.acquireLockOnInstance(client, key, token, ttlMs)),
      );
      const successCount = acquired.filter((result) => result).length;

      if (successCount >= this.quorum) {
        const actualValidity = ttlMs - (Date.now() - startTime) - Math.floor(ttlMs * this.driftFactor);
        return { token, validityTime: Math.max(actualValidity, 0) };
      }

      await this.releaseLockOnAllInstances(key, token);

      if (attempt < this.retryCount - 1) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
      attempt++;
    }

    throw new ConflictException('Failed to acquire lock on quorum of Redis instances');
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.releaseLockOnAllInstances(key, token);
  }

  private async releaseLockOnAllInstances(key: string, token: string): Promise<void> {
    await Promise.allSettled(
      this.clients.map((client) => this.releaseLockOnInstance(client, key, token)),
    );
  }

  async extendLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const results = await Promise.all(
      this.clients.map((client) => client.eval(script, 1, key, token, ttlMs.toString())),
    );
    const successCount = results.filter((result) => result === 1).length;
    return successCount >= this.quorum;
  }

  async withLock<T>(key: string, ttlMs: number, work: () => Promise<T>, extendIntervalMs?: number): Promise<T> {
    const lockResult = await this.acquireLock(key, ttlMs);
    let extendTimer: NodeJS.Timeout | null = null;

    if (extendIntervalMs && extendIntervalMs < lockResult.validityTime) {
      extendTimer = setInterval(async () => {
        const extended = await this.extendLock(key, lockResult.token, ttlMs);
        if (!extended) {
          this.logger.warn(`Failed to extend lock ${key}, may expire during operation`);
        }
      }, extendIntervalMs);
    }

    try {
      return await work();
    } finally {
      if (extendTimer) {
        clearInterval(extendTimer);
      }
      await this.releaseLock(key, lockResult.token);
    }
  }
}

