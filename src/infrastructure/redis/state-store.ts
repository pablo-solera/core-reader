import type { StateStore } from "../../application/ports/state-store.js";

export type StateMulti = {
  set(key: string, value: string, expiry: "EX", ttlSeconds: number): StateMulti;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
};
export type StateRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiry: "EX", ttlSeconds: number): Promise<unknown>;
  watch(key: string): Promise<unknown>;
  unwatch(): Promise<unknown>;
  multi(): StateMulti;
};

export class RedisStateStore<T extends { updatedAt: string }> implements StateStore<T> {
  constructor(private readonly client: StateRedis, private readonly keyFor: (id: string) => string, private readonly ttlSeconds: number) {}

  async get(id: string): Promise<T | null> {
    const raw = await this.client.get(this.keyFor(id));
    return raw ? JSON.parse(raw) as T : null;
  }

  async set(id: string, value: T, updatedAt = new Date().toISOString()): Promise<T> {
    const next = { ...value, updatedAt };
    await this.client.set(this.keyFor(id), JSON.stringify(next), "EX", this.ttlSeconds);
    return next;
  }

  async patch(id: string, patch: Partial<T>, deletedKeys: string[] = [], ifMatches: Partial<T> = {}): Promise<T | null> {
    const key = this.keyFor(id);
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.client.watch(key);
      try {
        const raw = await this.client.get(key);
        if (!raw) {
          await this.client.unwatch();
          return null;
        }
        const current = JSON.parse(raw) as T;
        if (Object.entries(ifMatches).some(([field, expected]) => current[field as keyof T] !== expected)) {
          await this.client.unwatch();
          return null;
        }
        const next = { ...current, ...patch, updatedAt: new Date().toISOString() } as T;
        for (const field of deletedKeys) delete (next as Record<string, unknown>)[field];
        const result = await this.client.multi().set(key, JSON.stringify(next), "EX", this.ttlSeconds).exec();
        if (result !== null) {
          const commandError = result.find(([error]) => error)?.[0];
          if (commandError) throw commandError;
          return next;
        }
      } catch (error) {
        await this.client.unwatch().catch(() => undefined);
        throw error;
      }
    }
    throw new Error(`Redis state patch conflicted too many times for ${id}`);
  }
}
