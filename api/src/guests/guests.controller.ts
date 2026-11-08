import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { Clock, CLOCK } from '../clock';
import { GuestGuard, GuestRequest } from './guests.guard';

@Controller('me')
@UseGuards(GuestGuard)
export class GuestsController {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  @Get()
  me(@Req() req: GuestRequest) {
    const { id, name, balance } = req.guest;
    // The house page draws against server time, not the worker's clock.
    return { id, name, balance, now: this.clock.now() };
  }
}
