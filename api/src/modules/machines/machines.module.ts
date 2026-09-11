import { Module } from '@nestjs/common';
import { MachinesController } from './machines.controller.js';
import { MachinesService } from './machines.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [SessionsModule, RealtimeModule, AuthModule],
  controllers: [MachinesController],
  providers: [MachinesService],
  exports: [MachinesService],
})
export class MachinesModule {}
