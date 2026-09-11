import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  timestamp: string;
  path: string;
}

/**
 * Normalizes every thrown error into one JSON shape and makes sure nothing
 * unhandled leaks internal details (stack traces, DB error text) to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ url: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'Internal Server Error';
    let message: string | string[] = 'An unexpected error occurred';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
        error = exception.name;
      } else if (typeof body === 'object' && body !== null) {
        const asRecord = body as Record<string, unknown>;
        message = (asRecord.message as string | string[]) ?? exception.message;
        error = (asRecord.error as string) ?? exception.name;
      }
    } else if (
      // Defense-in-depth: a malformed id/UUID reaching a Prisma query is
      // meant to be caught earlier (ParseUUIDPipe on route params, explicit
      // isUUID() checks where an id comes from a request body), but if one
      // ever slips through, it's still a client input problem, not a 500.
      exception instanceof Prisma.PrismaClientValidationError ||
      (exception instanceof Prisma.PrismaClientKnownRequestError &&
        exception.message.includes('invalid input syntax'))
    ) {
      status = HttpStatus.BAD_REQUEST;
      error = 'Bad Request';
      message = 'Invalid request';
      this.logger.warn(exception.message);
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    const payload: ErrorBody = {
      statusCode: status,
      error,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(status).json(payload);
  }
}
