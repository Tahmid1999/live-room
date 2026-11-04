import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransferBudget } from '../egress/transfer-budget';
import { GuestsModule } from '../guests/guests.module';
import { LIVEKIT_ROOMS, liveKitRooms } from './livekit-rooms';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { SeatSweep } from './seat-sweep';

@Module({
  imports: [GuestsModule],
  controllers: [RoomsController],
  providers: [
    RoomsService,
    TransferBudget,
    SeatSweep,
    {
      provide: LIVEKIT_ROOMS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        liveKitRooms(
          config.getOrThrow('LIVEKIT_URL'),
          config.getOrThrow('LIVEKIT_API_KEY'),
          config.getOrThrow('LIVEKIT_API_SECRET'),
        ),
    },
  ],
  exports: [RoomsService, TransferBudget, SeatSweep],
})
export class RoomsModule {}
