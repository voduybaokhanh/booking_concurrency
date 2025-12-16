import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';
import { envNumber } from '../config/env';

@Injectable()
export class IdempotencyCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyCleanupService.name);
  private intervalHandle?: NodeJS.Timer;

  constructor(private readonly idempotencyService: IdempotencyService) {}

  onModuleInit(): void {
    const intervalMs = envNumber('IDEMPOTENCY_CLEANUP_INTERVAL_MS', 60000);
    this.intervalHandle = setInterval(() => {
      this.idempotencyService
        .cleanupExpired()
        .then((deleted) => {
          if (deleted > 0) {
            this.logger.log(`Cleaned up ${deleted} expired idempotency records`);
          }
        })
        .catch((err) => {
          this.logger.error('Failed to cleanup expired idempotency records', err);
        });
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }
}

