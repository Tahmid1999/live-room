import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { RetentionService } from './retention.service';
import { SettlementService } from './settlement.service';

@Module({
  imports: [RealtimeModule],
  providers: [SettlementService, RetentionService],
  exports: [SettlementService, RetentionService],
})
export class JobsModule {}
