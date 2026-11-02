import { Module } from '@nestjs/common';
import { GuestsController } from './guests.controller';
import { GuestGuard } from './guests.guard';
import { GuestsService } from './guests.service';

@Module({
  controllers: [GuestsController],
  providers: [GuestsService, GuestGuard],
  exports: [GuestsService, GuestGuard],
})
export class GuestsModule {}
