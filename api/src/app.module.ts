import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module';
import { ClockModule } from './clock';
import { EgressModule } from './egress/egress.module';
import { validateEnv } from './env';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';
import { GuestsModule } from './guests/guests.module';
import { JobsModule } from './jobs/jobs.module';
import { PrismaModule } from './prisma.module';
import { ReadCacheModule } from './read-cache';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { ReplicaModule } from './replica';
import { RoomsModule } from './rooms/rooms.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    EventEmitterModule.forRoot(),
    // Tests call runOnce() themselves; a live cron would race them.
    ...(process.env.NODE_ENV === 'test' ? [] : [ScheduleModule.forRoot()]),
    ClockModule,
    ReplicaModule,
    EventsModule,
    PrismaModule,
    ReadCacheModule,
    RedisModule,
    GuestsModule,
    RoomsModule,
    WalletModule,
    RealtimeModule,
    JobsModule,
    EgressModule,
    AdminModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
