import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SeatModule } from './seat/seat.module';
import { BookingModule } from './booking/booking.module';
import { CommonModule } from './common/common.module';

@Module({
  imports: [SeatModule, BookingModule, CommonModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
