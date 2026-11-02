import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { RoomsModule } from '../rooms/rooms.module';
import { EgressController } from './egress.controller';
import { EgressService } from './egress.service';

// AgoraMinutes stays in RoomsModule: joins need it, and this module needs the
// gateway from RealtimeModule, which needs RoomsModule. Providing it here
// would close that loop.
@Module({
  imports: [RoomsModule, RealtimeModule],
  controllers: [EgressController],
  providers: [EgressService],
})
export class EgressModule {}
