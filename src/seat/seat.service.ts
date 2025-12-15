import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { envNumber } from '../common/config/env';
import { RedisLockService } from '../common/lock/redis-lock.service';

@Injectable()
export class SeatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lockService: RedisLockService,
  ) {}

  async createSeats(count: number): Promise<void> {
    if (!Number.isInteger(count) || count <= 0) {
      throw new BadRequestException('Count must be a positive integer');
    }

    const seats = Array.from({ length: count }).map(() => ({}));
    await this.prisma.seat.createMany({ data: seats });
  }

  async getSeat(seatId: string) {
    const seat = await this.prisma.seat.findUnique({ where: { id: seatId } });
    if (!seat) {
      throw new NotFoundException('Seat not found');
    }
    return seat;
  }

  async holdSeat(seatId: string) {
    const lockKey = `seat:${seatId}`;
    return this.lockService.withLock(lockKey, envNumber('LOCK_TTL_MS', 3000), async () => {
      const seat = await this.prisma.seat.findUnique({ where: { id: seatId } });
      if (!seat) {
        throw new NotFoundException('Seat not found');
      }

      const now = new Date();
      const expiredHold = seat.status === 'HOLD' && seat.holdExpiresAt && seat.holdExpiresAt <= now;
      if (seat.status === 'BOOKED') {
        throw new ConflictException('Seat already booked');
      }
      if (seat.status === 'HOLD' && !expiredHold) {
        throw new ConflictException('Seat already on hold');
      }

      const holdExpiresAt = new Date(Date.now() + envNumber('HOLD_TTL_MS', 120000));
      const result = await this.prisma.seat.updateMany({
        where: { id: seat.id, version: seat.version },
        data: {
          status: 'HOLD',
          holdExpiresAt,
          version: { increment: 1 },
        },
      });

      if (result.count === 0) {
        throw new ConflictException('Seat state changed, retry');
      }

      return this.prisma.seat.findUnique({ where: { id: seatId } });
    });
  }

  async releaseExpiredHolds(): Promise<number> {
    const now = new Date();
    const result = await this.prisma.seat.updateMany({
      where: { status: 'HOLD', holdExpiresAt: { lt: now } },
      data: {
        status: 'AVAILABLE',
        holdExpiresAt: null,
        version: { increment: 1 },
      },
    });
    return result.count;
  }
}

