import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';
import { SessionsSweeper } from './sessions.sweeper.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [RealtimeModule, AuthModule],
  controllers: [SessionsController],
  providers: [SessionsService, SessionsSweeper],
  exports: [SessionsService],
})
export class SessionsModule {}
