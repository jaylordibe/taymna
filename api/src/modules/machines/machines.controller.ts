import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MachinesService, EnrollResult } from './machines.service.js';
import { CreateMachineDto } from './dto/create-machine.dto.js';
import { UpdateMachineDto } from './dto/update-machine.dto.js';
import { EnrollDto } from './dto/enroll.dto.js';
import { OperatorAuthGuard } from '../../common/auth/operator-auth.guard.js';
import { MachineDto } from './machine.dto.js';

@Controller('machines')
export class MachinesController {
  constructor(private readonly machines: MachinesService) {}

  @Post()
  @UseGuards(OperatorAuthGuard)
  create(@Body() dto: CreateMachineDto) {
    return this.machines.create(dto.name, dto.platform);
  }

  @Get()
  @UseGuards(OperatorAuthGuard)
  list(): Promise<MachineDto[]> {
    return this.machines.list();
  }

  @Get(':id')
  @UseGuards(OperatorAuthGuard)
  get(@Param('id', ParseUUIDPipe) id: string): Promise<MachineDto> {
    return this.machines.get(id);
  }

  @Patch(':id')
  @UseGuards(OperatorAuthGuard)
  rename(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMachineDto,
  ): Promise<MachineDto> {
    return this.machines.rename(id, dto.name);
  }

  @Post(':id/enrollment-tokens')
  @UseGuards(OperatorAuthGuard)
  async issueEnrollmentToken(@Param('id', ParseUUIDPipe) id: string) {
    const issued = await this.machines.issueEnrollmentToken(id);
    return { token: issued.token, expiresAt: issued.expiresAt.toISOString() };
  }

  @Delete(':id/credential')
  @UseGuards(OperatorAuthGuard)
  revokeCredential(@Param('id', ParseUUIDPipe) id: string): Promise<MachineDto> {
    return this.machines.revokeCredential(id);
  }

  @Delete(':id')
  @UseGuards(OperatorAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.machines.remove(id);
  }

  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  enroll(@Body() dto: EnrollDto): Promise<EnrollResult> {
    return this.machines.enroll(dto.token);
  }
}
