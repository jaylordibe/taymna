import { Module } from '@nestjs/common';
import { ConnectionRegistryService } from './connection-registry.service.js';

@Module({
  providers: [ConnectionRegistryService],
  exports: [ConnectionRegistryService],
})
export class RealtimeModule {}
