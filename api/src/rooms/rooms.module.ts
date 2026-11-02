import { Module } from '@nestjs/common';
import { AgoraMinutes } from '../egress/agora-minutes';
import { GuestsModule } from '../guests/guests.module';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

@Module({
  imports: [GuestsModule],
  controllers: [RoomsController],
  providers: [RoomsService, AgoraMinutes],
})
export class RoomsModule {}
