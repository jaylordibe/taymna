import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { OperatorJwtPayload } from './jwt-payload.js';

export interface AuthenticatedRequest extends Request {
  operator: OperatorJwtPayload;
}

/**
 * Guards REST routes that require a logged-in operator. The dashboard sends
 * the JWT as `Authorization: Bearer <token>` (no cookies -- see
 * docs/security.md for why: this removes CSRF as an attack surface for a
 * LAN/self-hosted single-admin tool at the cost of XSS being the residual
 * risk, which Next.js's default output escaping mitigates).
 */
@Injectable()
export class OperatorAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      request.operator = this.jwt.verify<OperatorJwtPayload>(token);
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

export function extractBearerToken(header?: string): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}
