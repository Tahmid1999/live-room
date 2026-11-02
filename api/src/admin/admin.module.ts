import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminAuth, AdminGuard } from './admin.auth';
import { AdminController } from './admin.controller';

@Module({
  imports: [RealtimeModule],
  controllers: [AdminController],
  providers: [AdminAuth, AdminGuard],
})
export class AdminModule {}
