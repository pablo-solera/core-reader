import { createKeyspace } from "./keyspace.js";
import { RedisLeaseLock, type RedisLockClient } from "./lock.js";

export const defaultWorkerLeaseMs = 30000;

const renewScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[3]); redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]); return 1 else return 0 end";
const clearHeartbeatScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[2]) else return 0 end";

export type WorkerLockOptions = { namespace: string; leaseMs?: number };

export function workerKeys(namespace: string) {
  const key = createKeyspace(namespace);
  return { lockKey: key("worker", "singleton"), heartbeatKey: key("worker", "heartbeat") };
}

export function createWorkerLock(client: RedisLockClient, options: WorkerLockOptions) {
  const leaseMs = options.leaseMs ?? defaultWorkerLeaseMs;
  const { lockKey, heartbeatKey } = workerKeys(options.namespace);
  const lock = new RedisLeaseLock(client);
  return {
    lockKey,
    heartbeatKey,
    leaseMs,
    acquire: (token: string) => lock.acquire(lockKey, token, leaseMs),
    async renew(token: string, now = Date.now()): Promise<boolean> {
      return Number(await client.eval(renewScript, 2, lockKey, heartbeatKey, token, now, leaseMs)) === 1;
    },
    async clearHeartbeat(token: string): Promise<boolean> {
      return Number(await client.eval(clearHeartbeatScript, 2, lockKey, heartbeatKey, token)) === 1;
    },
    async release(token: string): Promise<void> {
      await lock.release(lockKey, token);
    },
    async assertAlive(reader: { pttl(key: string): Promise<number> }): Promise<void> {
      if (await reader.pttl(heartbeatKey) <= 0) throw new Error("Worker heartbeat is missing or expired");
    },
  };
}

export type WorkerLock = ReturnType<typeof createWorkerLock>;
