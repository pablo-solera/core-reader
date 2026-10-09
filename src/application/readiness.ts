import type { ReadinessCheck } from "./ports/runtime.js";

export type ReadinessResult = { ready: boolean; checks: Record<string, "ok" | "error"> };

export async function checkReadiness(checks: Record<string, ReadinessCheck>): Promise<ReadinessResult> {
  const results = await Promise.all(Object.entries(checks).map(async ([name, check]) => {
    try { await check(); return [name, "ok"] as const; }
    catch { return [name, "error"] as const; }
  }));
  const values = Object.fromEntries(results);
  return { ready: Object.values(values).every(result => result === "ok"), checks: values };
}
