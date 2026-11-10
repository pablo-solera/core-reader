import { describe, expect, test } from "bun:test";
import { createRedisRateLimiter, rateLimitKeys } from "../src/infrastructure/redis/rate-limiter.js";
import { RequestAbortedError } from "../src/shared/retry.js";

const options = { namespace: "mercedes-reader", perSecond: 3, maxCooldownMs: 1800000, minTimeMs: 25 };

describe("Redis rate limiter", () => {
  test("derives namespaced keys", () => {
    expect(rateLimitKeys("x:")).toMatchObject({ cooldown: "x:rate:cooldown", waiters: "x:rate:waiters", waitersSeen: "x:rate:waiters-seen", count: "x:rate:429-count", lastLog: "x:rate:last-log" });
  });

  test("uses Redis Lua for shared reservations and cooldown reporting", async () => {
    const calls: Array<{ script: string; keys: string[]; args: Array<string | number> }> = [];
    const acquireResults = [5, 0];
    const redis = {
      async eval(script: string, keyCount: number, ...args: Array<string | number>) {
        calls.push({ script, keys: args.slice(0, keyCount).map(String), args: args.slice(keyCount) });
        if (keyCount === 6) return acquireResults.shift() ?? 0;
        if (keyCount === 3) return [500, 2, 1];
        return 1;
      },
    };
    const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
    const limiter = createRedisRateLimiter(redis, { ...options, logger: { warn: (event, data) => { warnings.push([event, data]); } } });
    await limiter.acquire(undefined, "interactive");
    expect(calls.slice(0, 2).every(call => call.keys[0] === "mercedes-reader:rate:cooldown")).toBe(true);
    expect(calls[0]?.keys[4]).toBe("mercedes-reader:rate:waiters");
    expect(calls[0]?.args[2]).toBe("interactive");
    expect(calls[0]?.script).toContain("redis.call('TIME')");
    expect(calls[0]?.script).toContain("priority * 10000000000000 + now");
    expect(await limiter.reportCooldown(1200)).toEqual({ waitMs: 500, count: 2 });
    expect(calls[2]?.keys).toEqual(["mercedes-reader:rate:cooldown", "mercedes-reader:rate:429-count", "mercedes-reader:rate:last-log"]);
    expect(warnings[0]![0]).toBe("mercedes-reader_rate_limited");
    expect(warnings[0]![1]).toMatchObject({ count: 2, cooldownMs: 500, ratePerSecond: 3 });
  });

  test("report429 is an alias of reportCooldown and honours the event prefix", async () => {
    const warnings: string[] = [];
    const redis = { async eval() { return [100, 1, 1]; } };
    const limiter = createRedisRateLimiter(redis, { ...options, eventPrefix: "mb", logger: { warn: event => { warnings.push(event); } } });
    await limiter.report429(0);
    expect(warnings).toEqual(["mb_rate_limited"]);
  });

  test("does not log when the script says the warning is throttled", async () => {
    const warnings: string[] = [];
    const limiter = createRedisRateLimiter({ async eval() { return [100, 5, 0]; } }, { ...options, logger: { warn: event => { warnings.push(event); } } });
    await limiter.reportCooldown(0);
    expect(warnings).toEqual([]);
  });

  test("sends only the SHA once Redis knows the script and reloads after NOSCRIPT", async () => {
    const used: string[] = [];
    let known = false;
    const redis = {
      async eval() { used.push("eval"); known = true; return 0; },
      async evalsha(sha: string) { used.push(`evalsha:${sha.length}`); if (!known) throw new Error("NOSCRIPT No matching script."); return 0; },
    };
    const limiter = createRedisRateLimiter(redis, options);
    await limiter.acquire();
    await limiter.acquire();
    expect(used).toEqual(["evalsha:40", "eval", "evalsha:40"]);
  });

  test("does not hide other Redis errors behind the fallback", async () => {
    const redis = { async eval() { return 0; }, async evalsha() { throw new Error("READONLY replica"); } };
    await expect(createRedisRateLimiter(redis, options).acquire()).rejects.toThrow("READONLY");
  });

  test("an aborted wait releases its place in the queue and throws RequestAbortedError", async () => {
    const released: number[] = [];
    const controller = new AbortController();
    const redis = {
      async eval(_script: string, keyCount: number) {
        if (keyCount === 2) { released.push(keyCount); return 1; }
        controller.abort();
        return 5000;
      },
    };
    await expect(createRedisRateLimiter(redis, options).acquire(controller.signal)).rejects.toBeInstanceOf(RequestAbortedError);
    expect(released).toEqual([2]);
  });
});
