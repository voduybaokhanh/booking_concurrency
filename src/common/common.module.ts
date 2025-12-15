import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { RedisLockService } from './lock/redis-lock.service';
import { TransactionService } from './transaction/transaction.service';

@Global()
@Module({
  providers: [PrismaService, RedisLockService, TransactionService],
  exports: [PrismaService, RedisLockService, TransactionService],
})
export class CommonModule {}
