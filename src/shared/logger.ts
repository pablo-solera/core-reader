import type { Logger } from "../application/ports/runtime.js";

type Sink = Pick<Console, "info" | "warn" | "error">;

/** One JSON object per line: `{ event, ...data }`. Callers must never pass secrets or raw payloads. */
export function createJsonLogger(sink: Sink = console): Logger {
  const line = (event: string, data: Record<string, unknown>) => JSON.stringify({ event, ...data });
  return {
    info: (event, data = {}) => sink.info(line(event, data)),
    warn: (event, data = {}) => sink.warn(line(event, data)),
    error: (event, data = {}) => sink.error(line(event, data)),
  };
}
