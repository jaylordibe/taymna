import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { OperatorJwtPayload } from '../common/auth/jwt-payload.js';

export interface LoginResult {
  token: string;
  operator: { id: string; email: string };
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Self-hosting bootstrap: if this is a brand-new install with no operator
   * yet, create the initial admin account from env vars. Documented in
   * docs/self-hosting.md. Idempotent -- does nothing once an operator exists.
   */
  async onModuleInit(): Promise<void> {
    const existing = await this.prisma.operator.count();
    if (existing > 0) return;

    const passwordHash = await argon2.hash(this.config.adminPassword, {
      type: argon2.argon2id,
    });
    await this.prisma.operator.create({
      data: { email: this.config.adminEmail, passwordHash },
    });
    this.logger.log(
      `Created initial operator account for ${this.config.adminEmail}`,
    );
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const operator = await this.prisma.operator.findUnique({
      where: { email },
    });

    // Always run argon2.verify, even with a dummy hash, so failed lookups
    // and failed password checks take the same time (no user-enumeration
    // via timing).
    const passwordHash =
      operator?.passwordHash ??
      '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const valid = await argon2.verify(passwordHash, password).catch(() => false);

    if (!operator || !valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const payload: OperatorJwtPayload = { sub: operator.id, email: operator.email };
    return {
      token: this.jwt.sign(payload),
      operator: { id: operator.id, email: operator.email },
    };
  }
}
