import { describe, expect, test } from "bun:test";
import { createRedisRequestIndex, type RequestIndexRedis } from "../src/infrastructure/redis/request-index.js";
import { listRequestsPage } from "../src/application/list-requests.js";
import { parseRequestCursor, requestNextCursor } from "../src/domain/cursor.js";
import { ValidationError } from "../src/domain/errors.js";

function fakeRedis(): RequestIndexRedis {
  const sorted = new Map<string, Map<string, number>>();
  const values = new Map<string, string>();
  const setFor = (key: string) => {
    const current = sorted.get(key) ?? new Map<string, number>();
    sorted.set(key, current);
    return current;
  };
  const bound = (value: string | number, isMin: boolean) => {
    const text = String(value);
    if (text === "+inf") return Number.POSITIVE_INFINITY;
    if (text === "-inf") return Number.NEGATIVE_INFINITY;
    const number = Number(text.startsWith("(") ? text.slice(1) : text);
    return text.startsWith("(") ? number + (isMin ? 0.5 : -0.5) : number;
  };
  const mock = {
    async set(key: string, value: string, _expiry: "PX", _ttl: number, nx?: "NX") {
      if (nx === "NX" && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    async exists(key: string) { return Number(values.has(key)); },
    async eval(_script: string, _keyCount: number, ...args: Array<string | number>) {
      const [key, token] = args.map(String);
      if (values.get(key!) === token) values.delete(key!);
      return 1;
    },
    async zadd(key: string, score: number, member: string) { const set = setFor(key); const existed = set.has(member); set.set(member, score); return Number(!existed); },
    async pexpire() { return 1; },
    async zremrangebyscore(key: string, min: string | number, max: string | number) {
      const set = setFor(key);
      const lower = bound(min, true), upper = bound(max, false);
      let removed = 0;
      for (const [member, score] of set) if (score >= lower && score <= upper) { set.delete(member); removed++; }
      return removed;
    },
    async zrangebyscore(key: string, min: string | number, max: string | number) {
      const lower = bound(min, true), upper = bound(max, false);
      return [...setFor(key)].filter(([, score]) => score >= lower && score <= upper).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([member]) => member);
    },
    async zrevrangebyscore(key: string, max: string | number, min: string | number, _limit: "LIMIT", offset: number, count: number) {
      const upper = bound(max, false), lower = bound(min, true);
      return [...setFor(key)].filter(([, score]) => score <= upper && score >= lower).sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).slice(Number(offset), Number(offset) + Number(count)).map(([member]) => member);
    },
    async mget(...keys: string[]) { return keys.map(key => values.get(key) ?? null); },
    async zrem(key: string, ...members: string[]) { const set = setFor(key); let removed = 0; for (const member of members) removed += Number(set.delete(member)); return removed; },
  };
  return mock as unknown as RequestIndexRedis;
}

describe("request cursor", () => {
  test("round-trips a position", () => {
    expect(parseRequestCursor(requestNextCursor({ score: 1700000000000, requestId: "abc-123" }))).toEqual({ score: 1700000000000, requestId: "abc-123" });
    expect(parseRequestCursor(undefined)).toBeNull();
  });

  test("rejects malformed cursors with a ValidationError", () => {
    for (const bad of ["***", Buffer.from("v1:1:a").toString("base64url"), Buffer.from("v2:-1:a").toString("base64url"), Buffer.from("v2:1:a b").toString("base64url")]) {
      expect(() => parseRequestCursor(bad)).toThrow(ValidationError);
    }
  });
});

describe("Redis request index", () => {
  const stateKey = (id: string) => `state:${id}`;

  test("namespaces its keys by reader and resource", () => {
    expect(createRedisRequestIndex(fakeRedis(), { namespace: "mercedes-reader", ttlMs: 1, stateKey }).key).toBe("mercedes-reader:labours:index");
    expect(createRedisRequestIndex(fakeRedis(), { namespace: "x", resource: "parts", ttlMs: 1, stateKey }).key).toBe("x:parts:index");
  });

  test("initializes once, prunes dangling ids and returns indexed requests", async () => {
    const redis = fakeRedis();
    const index = createRedisRequestIndex(redis, { namespace: "x", ttlMs: 60_000, stateKey });
    const createdAt = new Date().toISOString();
    await index.add({ requestId: "present", createdAt });
    await redis.zadd(index.key, Date.now(), "missing");
    await redis.set("state:present", "{}", "PX", 60000);
    await index.ensure();
    await index.ensure();
    expect(await index.requestIds()).toEqual(["present"]);
  });

  test("ignores entries without a valid createdAt", async () => {
    const redis = fakeRedis();
    const index = createRedisRequestIndex(redis, { namespace: "x", ttlMs: 60_000, stateKey });
    await index.add({ requestId: "bad", createdAt: "nope" });
    expect(await redis.zrangebyscore(index.key, "-inf", "+inf")).toEqual([]);
  });

  test("paginates equal timestamps by stable request-id keyset", async () => {
    const index = createRedisRequestIndex(fakeRedis(), { namespace: "x", ttlMs: 60_000, stateKey });
    const recent = new Date().toISOString();
    const score = Date.parse(recent);
    for (const id of ["a", "b", "c"]) await index.add({ requestId: id, createdAt: recent });
    await index.add({ requestId: "d", createdAt: new Date(score - 1000).toISOString() });
    expect(await index.fetchRequestIds(0, null, 2)).toEqual(["c", "b"]);
    expect(await index.fetchRequestIds(0, { score, requestId: "b" }, 2)).toEqual(["a", "d"]);
  });
});

describe("listRequestsPage", () => {
  type State = { requestId: string; createdAt: string; status: "ok" | "skip" };
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const states: State[] = Array.from({ length: 7 }, (_v, i) => ({ requestId: `r${i}`, createdAt: new Date(base + i * 1000).toISOString(), status: i % 3 === 0 ? "skip" : "ok" }));

  async function setup() {
    const redis = fakeRedis();
    const index = createRedisRequestIndex(redis, { namespace: "x", ttlMs: 10 * 365 * 24 * 3600_000, stateKey: id => `state:${id}` });
    for (const state of states) { await index.add(state); await redis.set(`state:${state.requestId}`, JSON.stringify(state), "PX", 1000); }
    return (cursor: string | undefined, count: number) => listRequestsPage<State, string>(cursor, count, {
      ensureIndex: index.ensure,
      cutoff: () => 0,
      pruneExpired: index.pruneExpired,
      fetchRequestIds: index.fetchRequestIds,
      fetchStates: async ids => (await redis.mget(...ids.map(id => `state:${id}`))).map(value => value ? JSON.parse(value) as State : null),
      removeMissing: index.remove,
      summarize: state => state.status === "ok" ? [state.requestId] : [],
    });
  }

  test("walks every matching item newest-first across pages without duplicates", async () => {
    const list = await setup();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(cursor, 2);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["r5", "r4", "r2", "r1"]);
  });

  test("returns no cursor when everything fits in one page", async () => {
    const list = await setup();
    const page = await list(undefined, 10);
    expect(page).toEqual({ items: ["r5", "r4", "r2", "r1"], nextCursor: null });
  });

  test("rejects an invalid cursor", async () => {
    const list = await setup();
    await expect(list("***", 2)).rejects.toThrow(ValidationError);
  });
});
