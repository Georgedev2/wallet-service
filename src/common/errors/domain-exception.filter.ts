import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { DatabaseError } from 'pg';
import { DomainError } from './domain.error';

interface ErrorBody {
  error: { code: string; message: string };
}

const UNIQUE_VIOLATION = '23505';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const [status, body] = this.toResponse(exception);
    res.status(status).json(body);
  }

  private toResponse(exception: unknown): [number, ErrorBody] {
    if (exception instanceof DomainError) {
      return [exception.httpStatus, errorBody(exception.code, exception.message)];
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        status === HttpStatus.BAD_REQUEST
          ? 'VALIDATION_ERROR'
          : (HttpStatus[status] ?? 'HTTP_ERROR');
      return [status, errorBody(code, httpExceptionMessage(exception))];
    }

    // A unique index caught a duplicate that a pre-check missed (e.g. two
    // signups racing). Constraint names stay in the logs, not the response.
    if (exception instanceof DatabaseError && exception.code === UNIQUE_VIOLATION) {
      this.logger.warn(`Unique violation: ${exception.constraint ?? 'unknown constraint'}`);
      return [HttpStatus.CONFLICT, errorBody('CONFLICT', 'Resource already exists')];
    }

    this.logger.error(
      exception instanceof Error ? exception.message : 'Non-Error thrown',
      exception instanceof Error ? exception.stack : String(exception),
    );
    return [
      HttpStatus.INTERNAL_SERVER_ERROR,
      errorBody('INTERNAL_ERROR', 'An unexpected error occurred'),
    ];
  }
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/** ValidationPipe puts a string[] in `message`; flatten it to one string. */
function httpExceptionMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const { message } = response;
    if (Array.isArray(message)) {
      return message.join('; ');
    }
    if (typeof message === 'string') {
      return message;
    }
  }
  return exception.message;
}
