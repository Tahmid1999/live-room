import { Module } from '@nestjs/common';
import { TransferBudget } from '../egress/transfer-budget';
import { GuestsModule } from '../guests/guests.module';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

@Module({
  imports: [GuestsModule],
  controllers: [RoomsController],
  providers: [RoomsService, TransferBudget],
  exports: [RoomsService, TransferBudget],
})
export class RoomsModule {}
