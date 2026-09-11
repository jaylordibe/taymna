import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Thin typed wrapper around ConfigService so the rest of the app never reads
 * process.env / untyped keys directly. Values are guaranteed present because
 * envValidationSchema fails app startup otherwise.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  get nodeEnv(): string {
    return this.config.get<string>('NODE_ENV', 'development');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get databaseUrl(): string {
    return this.getRequired('DATABASE_URL');
  }

  get jwtSecret(): string {
    return this.getRequired('JWT_SECRET');
  }

  get port(): number {
    return this.config.get<number>('PORT', 3000);
  }

  get webOrigins(): string[] {
    return this.getRequired('WEB_ORIGIN')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  get heartbeatTimeoutSeconds(): number {
    return this.config.get<number>('HEARTBEAT_TIMEOUT_SECONDS', 60);
  }

  get adminEmail(): string {
    return this.getRequired('ADMIN_EMAIL');
  }

  get adminPassword(): string {
    return this.getRequired('ADMIN_PASSWORD');
  }

  private getRequired(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  }
}
