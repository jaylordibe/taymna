import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SessionsService } from './sessions.service.js';
import { StartSessionDto } from './dto/start-session.dto.js';
import { ExtendSessionDto } from './dto/extend-session.dto.js';
import { OperatorAuthGuard } from '../common/auth/operator-auth.guard.js';
import { SessionStateDto } from '../realtime/protocol.js';

@Controller()
@UseGuards(OperatorAuthGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post('machines/:machineId/sessions')
  async start(
    @Param('machineId', ParseUUIDPipe) machineId: string,
    @Body() dto: StartSessionDto,
  ): Promise<SessionStateDto> {
    const session = await this.sessions.start(machineId, dto.durationMinutes);
    return SessionsService.toDto(session);
  }

  @Get('machines/:machineId/sessions/active')
  async getActive(
    @Param('machineId', ParseUUIDPipe) machineId: string,
  ): Promise<{ session: SessionStateDto | null }> {
    // Wrapped in an object rather than returning a bare value: Nest/Express
    // sends a NULL return as an empty response body (no Content-Type, no
    // "null" bytes), which would throw in any client calling response.json().
    const session = await this.sessions.getActiveSession(machineId);
    return { session: session ? SessionsService.toDto(session) : null };
  }

  @Post('sessions/:sessionId/extend')
  async extend(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: ExtendSessionDto,
  ): Promise<SessionStateDto> {
    const session = await this.sessions.extend(sessionId, dto.additionalMinutes);
    return SessionsService.toDto(session);
  }

  @Post('sessions/:sessionId/end')
  @HttpCode(HttpStatus.OK)
  async end(@Param('sessionId', ParseUUIDPipe) sessionId: string): Promise<SessionStateDto> {
    const session = await this.sessions.end(sessionId);
    return SessionsService.toDto(session);
  }
}
