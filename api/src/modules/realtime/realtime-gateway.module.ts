import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeModule } from './realtime.module.js';
import { MachinesModule } from '../machines/machines.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { AuthModule } from '../auth/auth.module.js';

/**
 * Wires the actual @WebSocketGateway with its full dependency graph
 * (Machines/Sessions/Auth). Kept separate from RealtimeModule -- which only
 * provides the connection registry -- so Machines/Sessions can depend on the
 * registry without a module import cycle back through the gateway.
 */
@Module({
  imports: [RealtimeModule, MachinesModule, SessionsModule, AuthModule],
  providers: [RealtimeGateway],
})
export class RealtimeGatewayModule {}
