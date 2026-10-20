import type { StateStore } from "../../application/ports/state-store.js";
import { randomUUID } from "node:crypto";

export type StateRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiry: "EX", ttlSeconds: number): Promise<unknown>;
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
};

const patchScript = `
local function protectEmptyArrays(value, sentinel)
  local output = {}
  local in_string = false
  local escaped = false
  local index = 1
  while index <= #value do
    local char = string.sub(value, index, index)
    if in_string then
      table.insert(output, char)
      if escaped then escaped = false
      elseif char == '\\\\' then escaped = true
      elseif char == '"' then in_string = false end
      index = index + 1
    elseif char == '"' then
      in_string = true
      table.insert(output, char)
      index = index + 1
    elseif char == '[' then
      local next_index = index + 1
      while next_index <= #value and string.match(string.sub(value, next_index, next_index), '%s') do next_index = next_index + 1 end
      if string.sub(value, next_index, next_index) == ']' then
        table.insert(output, '"' .. sentinel .. '"')
        index = next_index + 1
      else
        table.insert(output, char)
        index = index + 1
      end
    else
      table.insert(output, char)
      index = index + 1
    end
  end
  return table.concat(output)
end
local current = redis.call('GET', KEYS[1])
if not current then return nil end
local sentinel = '__reader_core_empty_array_' .. ARGV[6] .. '__'
local state = cjson.decode(protectEmptyArrays(current, sentinel))
local patch = cjson.decode(protectEmptyArrays(ARGV[1], sentinel))
local conditions = cjson.decode(ARGV[5])
for key, expected in pairs(conditions) do
  if state[key] ~= expected then return false end
end
for key, value in pairs(patch) do state[key] = value end
local deleted = cjson.decode(ARGV[4])
for _, key in ipairs(deleted) do state[key] = nil end
state.updatedAt = ARGV[3]
local encoded = cjson.encode(state)
encoded = string.gsub(encoded, '"' .. sentinel .. '"', '[]')
redis.call('SET', KEYS[1], encoded, 'EX', tonumber(ARGV[2]))
return encoded
`;

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
    const raw = await this.client.eval(patchScript, 1, this.keyFor(id), JSON.stringify(patch), this.ttlSeconds, new Date().toISOString(), JSON.stringify(deletedKeys), JSON.stringify(ifMatches), randomUUID());
    if (!raw) return null;
    return JSON.parse(String(raw)) as T;
  }
}
