import { ConflictException, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

@Injectable()
export class RedisLockService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async acquireLock(key: string, ttlMs: number): Promise<string> {
    const token = randomUUID();
    const result = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    if (result !== 'OK') {
      throw new ConflictException('Lock already held');
    }
    return token;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    const script =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
    await this.client.eval(script, 1, key, token);
  }

  async withLock<T>(key: string, ttlMs: number, work: () => Promise<T>): Promise<T> {
    const token = await this.acquireLock(key, ttlMs);
    try {
      return await work();
    } finally {
      await this.releaseLock(key, token);
    }
  }
}

