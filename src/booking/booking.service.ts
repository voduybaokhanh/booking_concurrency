import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { TransactionService } from '../common/transaction/transaction.service';
import { RedlockService } from '../common/lock/redlock.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { envNumber } from '../common/config/env';

interface CreateBookingInput {
  seatId: string;
  userId: string;
  idempotencyKey: string;
}

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactionService: TransactionService,
    private readonly lockService: RedlockService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  async createBooking(input: CreateBookingInput) {
    if (!input.seatId || !input.userId) {
      throw new BadRequestException('seatId and userId are required');
    }
    if (!input.idempotencyKey) {
      throw new BadRequestException('Idempotency-Key is required');
    }

    const lockKey = `seat:${input.seatId}`;
    const lockTtlMs = envNumber('LOCK_TTL_MS', 5000);
    const extendIntervalMs = Math.floor(lockTtlMs * 0.6);

    const idempotencyResult = await this.idempotencyService.checkOrCreate(
      input.idempotencyKey,
      { seatId: input.seatId, userId: input.userId },
      async () => {
        return this.lockService.withLock(
          lockKey,
          lockTtlMs,
          async () => {
            return this.transactionService.runInTransaction(async (tx) => {
              const seat = await tx.seat.findUnique({ where: { id: input.seatId } });
              if (!seat) {
                throw new NotFoundException('Seat not found');
              }

              const now = new Date();
              const holdExpired = seat.status === 'HOLD' && seat.holdExpiresAt && seat.holdExpiresAt <= now;
              if (seat.status === 'BOOKED') {
                throw new ConflictException('Seat already booked');
              }
              if (seat.status === 'HOLD' && !holdExpired) {
                throw new ConflictException('Seat currently on hold');
              }

              const booking = await tx.booking.create({
                data: {
                  seatId: input.seatId,
                  userId: input.userId,
                  status: 'CONFIRMED',
                  idempotencyKey: input.idempotencyKey,
                },
              });

              const updated = await tx.seat.updateMany({
                where: { id: seat.id, version: seat.version },
                data: {
                  status: 'BOOKED',
                  holdExpiresAt: null,
                  version: { increment: 1 },
                },
              });

              if (updated.count === 0) {
                throw new ConflictException('Seat changed during booking');
              }

              return { data: booking, statusCode: 201 };
            });
          },
          extendIntervalMs,
        );
      },
    );

    if (idempotencyResult.isDuplicate) {
      return idempotencyResult.cachedResponse;
    }

    return idempotencyResult.cachedResponse;
  }

  async getBooking(id: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: { seat: true },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    return booking;
  }
}

