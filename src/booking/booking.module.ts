import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingController } from './booking.controller';
import { BookingCleanupService } from './booking.cleanup.service';

@Module({
  controllers: [BookingController],
  providers: [BookingService, BookingCleanupService],
})
export class BookingModule {}
