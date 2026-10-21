export const applicationErrorCodes = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "NOT_READY",
  "NOT_DOWNLOADABLE",
  "PAYLOAD_TOO_LARGE",
  "NOT_SUPPORTED",
  "UPSTREAM_ERROR",
  "UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type ApplicationErrorCode = (typeof applicationErrorCodes)[number];

export class ApplicationError extends Error {
  constructor(readonly code: ApplicationErrorCode, message: string, readonly details?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApplicationError";
  }
}

export class ValidationError extends ApplicationError { constructor(message: string, details?: Record<string, unknown>) { super("VALIDATION_ERROR", message, details); } }
export class NotFoundError extends ApplicationError { constructor(message: string, details?: Record<string, unknown>) { super("NOT_FOUND", message, details); } }
export class ConflictError extends ApplicationError { constructor(message: string, details?: Record<string, unknown>) { super("CONFLICT", message, details); } }
export class NotReadyError extends ApplicationError { constructor(message: string, details?: Record<string, unknown>) { super("NOT_READY", message, details); } }
export class NotDownloadableError extends ApplicationError { constructor(message: string, details?: Record<string, unknown>) { super("NOT_DOWNLOADABLE", message, details); } }
export class NotSupportedError extends ApplicationError { constructor(message: string, details?: Record<string, unknown>) { super("NOT_SUPPORTED", message, details); } }
export class UpstreamError extends ApplicationError { constructor(message: string, details?: Record<string, unknown>, options?: ErrorOptions) { super("UPSTREAM_ERROR", message, details, options); } }
export class UnavailableError extends ApplicationError { constructor(message: string, details?: Record<string, unknown>, options?: ErrorOptions) { super("UNAVAILABLE", message, details, options); } }
