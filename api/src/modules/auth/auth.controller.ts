import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService, LoginResult } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { OperatorAuthGuard } from '../../common/auth/operator-auth.guard.js';
import { CurrentOperator } from '../../common/auth/current-operator.decorator.js';
import type { OperatorJwtPayload } from '../../common/auth/jwt-payload.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.authService.login(dto.email, dto.password);
  }

  @Get('me')
  @UseGuards(OperatorAuthGuard)
  me(@CurrentOperator() operator: OperatorJwtPayload): OperatorJwtPayload {
    return operator;
  }
}
