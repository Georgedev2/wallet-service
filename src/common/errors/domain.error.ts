/**
 * Base class for every expected business error. Services throw these (never
 * Nest HttpExceptions); DomainExceptionFilter turns them into HTTP responses.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message, 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message, 403);
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message, 409);
  }
}

/** The request is well-formed but breaks a business rule (e.g. INSUFFICIENT_FUNDS). */
export class BusinessRuleError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message, 422);
  }
}
