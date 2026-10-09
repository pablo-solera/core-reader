export type StateRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiry: "EX", ttlSeconds: number): Promise<unknown>;
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
};

const patchScript = `
local current = redis.call('GET', KEYS[1])
if not current then return nil end
local state = cjson.decode(current)
local patch = cjson.decode(ARGV[1])
for key, value in pairs(patch) do state[key] = value end
local deleted = cjson.decode(ARGV[4])
for _, key in ipairs(deleted) do state[key] = nil end
state.updatedAt = ARGV[3]
local encoded = cjson.encode(state)
redis.call('SET', KEYS[1], encoded, 'EX', tonumber(ARGV[2]))
return encoded
`;

export class RedisStateStore<T extends { updatedAt: string }> {
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

  async patch(id: string, patch: Partial<T>, deletedKeys: string[] = []): Promise<T | null> {
    const raw = await this.client.eval(patchScript, 1, this.keyFor(id), JSON.stringify(patch), this.ttlSeconds, new Date().toISOString(), JSON.stringify(deletedKeys));
    if (!raw) return null;
    return JSON.parse(String(raw)) as T;
  }
}
