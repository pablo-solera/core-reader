export type RedisLockClient = {
  set(key: string, value: string, expiry: "PX", ttlMs: number, condition: "NX"): Promise<string | null>;
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
};

const releaseScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

export async function acquireLease(client: RedisLockClient, key: string, token: string, ttlMs: number): Promise<boolean> {
  return await client.set(key, token, "PX", ttlMs, "NX") === "OK";
}

export async function releaseLease(client: RedisLockClient, key: string, token: string): Promise<void> {
  await client.eval(releaseScript, 1, key, token);
}
