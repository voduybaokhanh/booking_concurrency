import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SeatService } from './seat.service';
import { envNumber } from '../common/config/env';

@Injectable()
export class SeatCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SeatCleanupService.name);
  private intervalHandle?: NodeJS.Timer;

  constructor(private readonly seatService: SeatService) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      this.seatService
        .releaseExpiredHolds()
        .then((released) => {
          if (released > 0) {
            this.logger.log(`Released ${released} expired holds`);
          }
        })
        .catch((err) => {
          this.logger.error('Failed to release expired holds', err);
        });
    }, envNumber('HOLD_SWEEP_INTERVAL_MS', 10000));
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }
}

