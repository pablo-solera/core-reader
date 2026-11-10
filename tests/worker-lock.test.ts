import { describe, expect, test } from "bun:test";
import { createWorkerLock, workerKeys } from "../src/infrastructure/redis/worker-lock.js";
import { checkWorkerHealth } from "../src/infrastructure/redis/worker-healthcheck.js";

type Call = { script: string; keyCount: number; args: Array<string | number> };
const recorder = (result: unknown) => {
  const calls: Call[] = [];
  return { calls, client: { eval: async (script: string, keyCount: number, ...args: Array<string | number>) => { calls.push({ script, keyCount, args }); return result; } } };
};

describe("worker lock", () => {
  test("derives keys from the reader namespace", () => {
    expect(workerKeys("bmw-reader")).toEqual({ lockKey: "bmw-reader:worker:singleton", heartbeatKey: "bmw-reader:worker:heartbeat" });
    expect(workerKeys("mercedes-reader:")).toEqual({ lockKey: "mercedes-reader:worker:singleton", heartbeatKey: "mercedes-reader:worker:heartbeat" });
  });

  test("acquires with the configured lease", async () => {
    const { client, calls } = recorder(1);
    const lock = createWorkerLock(client, { namespace: "x", leaseMs: 5000 });
    await expect(lock.acquire("tok")).resolves.toBe(true);
    expect(calls[0]!.args).toEqual(["x:worker:singleton", "tok", 5000]);
  });

  test("renew extends lock and heartbeat atomically for the owner", async () => {
    const { client, calls } = recorder(1);
    const lock = createWorkerLock(client, { namespace: "x" });
    await expect(lock.renew("tok", 123)).resolves.toBe(true);
    expect(calls[0]).toMatchObject({ keyCount: 2, args: ["x:worker:singleton", "x:worker:heartbeat", "tok", 123, 30000] });
    expect(calls[0]!.script).toContain("GET', KEYS[1]) == ARGV[1]");
  });

  test("renew reports lost ownership", async () => {
    const lock = createWorkerLock(recorder(0).client, { namespace: "x" });
    await expect(lock.renew("tok")).resolves.toBe(false);
  });

  test("clears the heartbeat only through an ownership-checked script", async () => {
    const { client, calls } = recorder(1);
    await expect(createWorkerLock(client, { namespace: "x" }).clearHeartbeat("tok")).resolves.toBe(true);
    expect(calls[0]!.script).toContain("redis.call('DEL', KEYS[2])");
    expect(calls[0]!.args).toEqual(["x:worker:singleton", "x:worker:heartbeat", "tok"]);
  });

  test("assertAlive fails for missing or expired heartbeats", async () => {
    const lock = createWorkerLock(recorder(1).client, { namespace: "x" });
    for (const ttl of [-2, -1, 0]) await expect(lock.assertAlive({ pttl: async () => ttl })).rejects.toThrow("Worker heartbeat is missing or expired");
    await expect(lock.assertAlive({ pttl: async () => 15000 })).resolves.toBeUndefined();
  });
});

describe("worker healthcheck", () => {
  const fake = (ttl: number | Error) => (url: string) => {
    let disconnected = false;
    return { url, get disconnected() { return disconnected; }, on() {}, connect: async () => {}, disconnect() { disconnected = true; }, pttl: async (key: string) => { if (ttl instanceof Error) throw ttl; expect(key).toBe("x:worker:heartbeat"); return ttl; } };
  };

  test("is healthy only with a live heartbeat", async () => {
    expect(await checkWorkerHealth({ namespace: "x", createClient: fake(10000) })).toBe(true);
    expect(await checkWorkerHealth({ namespace: "x", createClient: fake(-2) })).toBe(false);
  });

  test("is unhealthy when Redis fails, without throwing", async () => {
    expect(await checkWorkerHealth({ namespace: "x", createClient: fake(new Error("down")) })).toBe(false);
  });
});
