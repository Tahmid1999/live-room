import { Module } from '@nestjs/common';
import { GuestsModule } from '../guests/guests.module';
import { RoomsModule } from '../rooms/rooms.module';
import { LeaderboardService } from './leaderboard.service';
import { RoomGateway } from './room.gateway';

@Module({
  imports: [GuestsModule, RoomsModule],
  providers: [RoomGateway, LeaderboardService],
  exports: [RoomGateway, LeaderboardService],
})
export class RealtimeModule {}
