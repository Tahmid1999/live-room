import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';
import { SettlementService } from './settlement.service';

@Module({
  providers: [SettlementService, RetentionService],
  exports: [SettlementService, RetentionService],
})
export class JobsModule {}
