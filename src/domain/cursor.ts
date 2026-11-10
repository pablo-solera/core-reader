import { ValidationError } from "./errors.js";

export type RequestCursorPosition = { score: number; requestId: string };

export function parseRequestCursor(cursor?: string): RequestCursorPosition | null {
  if (!cursor) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new ValidationError("cursor is invalid");
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split(":");
  if (parts.length === 3 && parts[0] === "v2") {
    const score = Number(parts[1]);
    if (Number.isSafeInteger(score) && score >= 0 && /^[A-Za-z0-9-]+$/.test(parts[2]!)) return { score, requestId: parts[2]! };
  }
  throw new ValidationError("cursor is invalid");
}

export function requestNextCursor(position: RequestCursorPosition): string {
  return Buffer.from(`v2:${position.score}:${position.requestId}`).toString("base64url");
}
