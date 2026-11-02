import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClockModule } from './clock';
import { HealthController } from './health.controller';
import { GuestsModule } from './guests/guests.module';
import { PrismaModule } from './prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { RoomsModule } from './rooms/rooms.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    ClockModule,
    PrismaModule,
    RedisModule,
    GuestsModule,
    RoomsModule,
    WalletModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
