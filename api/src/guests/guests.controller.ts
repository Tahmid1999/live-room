import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { GuestGuard, GuestRequest } from './guests.guard';

@Controller('me')
@UseGuards(GuestGuard)
export class GuestsController {
  @Get()
  me(@Req() req: GuestRequest) {
    const { id, name, balance } = req.guest;
    return { id, name, balance };
  }
}
