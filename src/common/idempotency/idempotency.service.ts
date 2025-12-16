import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionService } from '../transaction/transaction.service';
import { createHash } from 'crypto';
import { envNumber } from '../config/env';

export enum IdempotencyState {
  IN_PROGRESS = 'IN_PROGRESS',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

interface IdempotencyResult<T> {
  isDuplicate: boolean;
  cachedResponse?: T;
  statusCode?: number;
}

@Injectable()
export class IdempotencyService {
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactionService: TransactionService,
  ) {
    this.ttlMs = envNumber('IDEMPOTENCY_TTL_MS', 300000);
  }

  private hashRequest(payload: unknown): string {
    const json = JSON.stringify(payload);
    return createHash('sha256').update(json).digest('hex');
  }

  async checkOrCreate<T>(
    idempotencyKey: string,
    requestPayload: unknown,
    work: () => Promise<{ data: T; statusCode: number }>,
  ): Promise<IdempotencyResult<T>> {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key is required');
    }

    const requestHash = this.hashRequest(requestPayload);
    const expiresAt = new Date(Date.now() + this.ttlMs);

    return this.transactionService.runInTransaction(async (tx) => {
      const existing = await tx.idempotencyRecord.findUnique({
        where: { idempotencyKey },
      });

      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException('Idempotency key reuse with different payload');
        }

        if (existing.state === IdempotencyState.SUCCESS) {
          if (!existing.responseData || existing.statusCode === null) {
            throw new InternalServerErrorException('Cached response missing');
          }
          return {
            isDuplicate: true,
            cachedResponse: JSON.parse(existing.responseData) as T,
            statusCode: existing.statusCode,
          };
        }

        if (existing.state === IdempotencyState.FAILED) {
          throw new ConflictException('Previous request with this idempotency key failed');
        }

        if (existing.state === IdempotencyState.IN_PROGRESS) {
          const now = new Date();
          const age = now.getTime() - existing.createdAt.getTime();
          if (age > this.ttlMs) {
            await tx.idempotencyRecord.update({
              where: { idempotencyKey },
              data: {
                state: IdempotencyState.FAILED,
                updatedAt: now,
              },
            });
            throw new ConflictException('Previous request timed out');
          }
          throw new ConflictException('Request already in progress');
        }
      }

      await tx.idempotencyRecord.create({
        data: {
          idempotencyKey,
          state: IdempotencyState.IN_PROGRESS,
          requestHash,
          expiresAt,
        },
      });

      let result: { data: T; statusCode: number } | null = null;
      let finalState: IdempotencyState = IdempotencyState.FAILED;

      try {
        result = await work();
        finalState = IdempotencyState.SUCCESS;
      } catch (error) {
        finalState = IdempotencyState.FAILED;
        throw error;
      } finally {
        await tx.idempotencyRecord.update({
          where: { idempotencyKey },
          data: {
            state: finalState,
            responseData: finalState === IdempotencyState.SUCCESS && result ? JSON.stringify(result.data) : null,
            statusCode: finalState === IdempotencyState.SUCCESS && result ? result.statusCode : null,
            updatedAt: new Date(),
          },
        });
      }

      if (!result) {
        throw new InternalServerErrorException('Work completed but result is missing');
      }

      return {
        isDuplicate: false,
        cachedResponse: result.data,
        statusCode: result.statusCode,
      };
    });
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date();
    const result = await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }
}

