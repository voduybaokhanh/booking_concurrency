import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { BookingService } from './booking.service';

@Controller('bookings')
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Post()
  async createBooking(
    @Body('seatId') seatId: string,
    @Body('userId') userId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.bookingService.createBooking({
      seatId,
      userId,
      idempotencyKey: idempotencyKey ?? '',
    });
  }

  @Get(':id')
  async getBooking(@Param('id') id: string) {
    return this.bookingService.getBooking(id);
  }
}

