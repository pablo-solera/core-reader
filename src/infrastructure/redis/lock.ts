import type { LeaseLock } from "../../application/ports/lease-lock.js";

export type RedisLockClient = {
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
};

const acquireLeaseScript = "if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 1 else return 0 end";
const renewLeaseScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";

export class RedisLeaseLock implements LeaseLock {
  constructor(private readonly client: RedisLockClient) {}

  async acquire(key: string, token: string, ttlMs: number) { return Number(await this.client.eval(acquireLeaseScript, 1, key, token, ttlMs)) === 1; }
  async renew(key: string, token: string, ttlMs: number) { return Number(await this.client.eval(renewLeaseScript, 1, key, token, ttlMs)) === 1; }
  async release(key: string, token: string) { return Number(await this.client.eval(releaseScript, 1, key, token)) === 1; }
}

const releaseScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
