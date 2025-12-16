import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { RedisLockService } from './lock/redis-lock.service';
import { RedlockService } from './lock/redlock.service';
import { TransactionService } from './transaction/transaction.service';
import { IdempotencyService } from './idempotency/idempotency.service';
import { IdempotencyCleanupService } from './idempotency/idempotency.cleanup.service';

@Global()
@Module({
  providers: [
    PrismaService,
    RedisLockService,
    RedlockService,
    TransactionService,
    IdempotencyService,
    IdempotencyCleanupService,
  ],
  exports: [
    PrismaService,
    RedisLockService,
    RedlockService,
    TransactionService,
    IdempotencyService,
  ],
})
export class CommonModule {}
