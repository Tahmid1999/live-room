import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClockModule } from './clock';
import { HealthController } from './health.controller';
import { GuestsModule } from './guests/guests.module';
import { PrismaModule } from './prisma.module';
import { RedisModule } from './redis/redis.module';
import { RoomsModule } from './rooms/rooms.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ClockModule,
    PrismaModule,
    RedisModule,
    GuestsModule,
    RoomsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
