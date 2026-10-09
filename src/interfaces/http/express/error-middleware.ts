import express, { type RequestHandler } from "express";
import { ApplicationError } from "../../../domain/errors.js";
import { ObjectNotFoundError } from "../../../domain/artifact-errors.js";
import type { ErrorCode } from "../../../contract/v1.js";

export type HttpError = { code: ErrorCode; status: number; message: string; details?: Record<string, unknown> };

const statusByCode: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NOT_READY: 409,
  NOT_DOWNLOADABLE: 409,
  PAYLOAD_TOO_LARGE: 413,
  NOT_SUPPORTED: 501,
  UPSTREAM_ERROR: 502,
  UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

type ZodIssue = { code: string; path: PropertyKey[]; message: string };
type ZodErrorLike = { name: string; issues: ZodIssue[] };

export function mapApplicationError(error: unknown): HttpError | null {
  if (error instanceof ApplicationError) {
    const legacyStatus = "status" in error && typeof error.status === "number" ? error.status : undefined;
    return { code: error.code, status: legacyStatus ?? statusByCode[error.code], message: error.message, details: error.details };
  }
  if (error instanceof ObjectNotFoundError) return { code: "NOT_FOUND", status: 404, message: error.message, details: { key: error.key } };
  const errorRecord = asRecord(error);
  const statusCode = errorRecord?.statusCode === undefined ? undefined : Number(errorRecord.statusCode);
  if (statusCode === 404) return { code: "NOT_FOUND", status: 404, message: error instanceof Error ? error.message : "Not found" };
  if (statusCode === 409) return { code: "CONFLICT", status: 409, message: error instanceof Error ? error.message : "Conflict" };
  if (isZodErrorLike(error)) {
    const issues = error.issues.map((issue: { code: string; path: PropertyKey[]; message: string }) => ({ code: issue.code, path: issue.path.map(String), message: issue.message }));
    return { code: "VALIDATION_ERROR", status: 400, message: issues.map(issue => issue.message).join("; "), details: { issues } };
  }
  if (errorRecord?.type === "entity.too.large") {
    return { code: "PAYLOAD_TOO_LARGE", status: 413, message: "Request body exceeds the configured size limit" };
  }
  if (error instanceof SyntaxError && errorRecord && "body" in errorRecord) return { code: "VALIDATION_ERROR", status: 400, message: "Malformed JSON request body" };
  return null;
}

function isZodErrorLike(error: unknown): error is ZodErrorLike {
  return !!error && typeof error === "object" && "name" in error && error.name === "ZodError" && "issues" in error && Array.isArray(error.issues);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function errorBody(code: ErrorCode, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export const readerErrorMiddleware: express.ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const mapped = mapApplicationError(error);
  if (mapped) return res.status(mapped.status).json(errorBody(mapped.code, mapped.message, mapped.details));
  console.error("Unhandled reader API error", error);
  return res.status(500).json(errorBody("INTERNAL_ERROR", "Internal server error"));
};

export const readerNotFoundMiddleware: RequestHandler = (req, res) => {
  res.status(404).json(errorBody("NOT_FOUND", "Route not found", { path: req.path, method: req.method }));
};
