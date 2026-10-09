export interface Clock { now(): Date; sleep(milliseconds: number, signal?: AbortSignal): Promise<void>; }
export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}
export type ReadinessCheck = () => Promise<void>;
