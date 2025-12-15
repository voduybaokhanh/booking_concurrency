import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SeatService } from './seat.service';

@Controller('seats')
export class SeatController {
  constructor(private readonly seatService: SeatService) {}

  @Post('seed')
  async seed(@Body('count') count: number) {
    await this.seatService.createSeats(Number(count));
    return { message: 'seats created', count: Number(count) };
  }

  @Get(':id')
  async getSeat(@Param('id') id: string) {
    return this.seatService.getSeat(id);
  }

  @Post(':id/hold')
  async holdSeat(@Param('id') id: string) {
    return this.seatService.holdSeat(id);
  }
}

