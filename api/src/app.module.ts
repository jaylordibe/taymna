import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from './config/app-config.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { MachinesModule } from './modules/machines/machines.module.js';
import { SessionsModule } from './modules/sessions/sessions.module.js';
import { RealtimeGatewayModule } from './modules/realtime/realtime-gateway.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        enabled: process.env.NODE_ENV !== 'test',
        transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.body.password',
            'req.body.token',
            'req.body.machineSecret',
          ],
          censor: '[redacted]',
        },
      },
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    AuthModule,
    MachinesModule,
    SessionsModule,
    RealtimeGatewayModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
