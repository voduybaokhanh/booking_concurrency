import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { envNumber } from '../common/config/env';

@Injectable()
export class BookingCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingCleanupService.name);
  private intervalHandle?: NodeJS.Timer;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    const intervalMs = envNumber('BOOKING_CLEANUP_INTERVAL_MS', 60000);
    this.intervalHandle = setInterval(() => {
      this.expireBookings()
        .then((expired) => {
          if (expired > 0) {
            this.logger.log(`Expired ${expired} bookings`);
          }
        })
        .catch((err) => {
          this.logger.error('Failed to expire bookings', err);
        });
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  async expireBookings(): Promise<number> {
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const expiredBookings = await tx.booking.findMany({
        where: {
          status: 'CONFIRMED',
          expiresAt: { lt: now },
        },
        select: { seatId: true },
      });

      if (expiredBookings.length === 0) {
        return { count: 0 };
      }

      const seatIds = expiredBookings.map((b) => b.seatId);

      await tx.booking.updateMany({
        where: {
          status: 'CONFIRMED',
          expiresAt: { lt: now },
        },
        data: { status: 'EXPIRED' },
      });

      await tx.seat.updateMany({
        where: {
          id: { in: seatIds },
          status: 'BOOKED',
        },
        data: {
          status: 'AVAILABLE',
          version: { increment: 1 },
        },
      });

      return { count: expiredBookings.length };
    });

    return result.count;
  }
}

