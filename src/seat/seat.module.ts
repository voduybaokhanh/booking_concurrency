import { Module } from '@nestjs/common';
import { SeatService } from './seat.service';
import { SeatController } from './seat.controller';
import { SeatCleanupService } from './seat.cleanup.service';

@Module({
  controllers: [SeatController],
  providers: [SeatService, SeatCleanupService],
  exports: [SeatService],
})
export class SeatModule {}
