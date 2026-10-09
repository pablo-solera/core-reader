import type { LeaseLock } from "../../application/ports/lease-lock.js";

export type RedisLockClient = {
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
};

const acquireLeaseScript = "if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 1 else return 0 end";
const renewLeaseScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";

export class RedisLeaseLock implements LeaseLock {
  constructor(private readonly client: RedisLockClient) {}

  acquire(key: string, token: string, ttlMs: number) { return acquireLease(this.client, key, token, ttlMs); }
  async renew(key: string, token: string, ttlMs: number) { return Number(await this.client.eval(renewLeaseScript, 1, key, token, ttlMs)) === 1; }
  async release(key: string, token: string) { return releaseLease(this.client, key, token); }
}


const releaseScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

export async function acquireLease(client: RedisLockClient, key: string, token: string, ttlMs: number): Promise<boolean> {
  return Number(await client.eval(acquireLeaseScript, 1, key, token, ttlMs)) === 1;
}

export async function releaseLease(client: RedisLockClient, key: string, token: string): Promise<boolean> {
  return Number(await client.eval(releaseScript, 1, key, token)) === 1;
}
