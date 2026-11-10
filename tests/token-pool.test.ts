import { describe, expect, test } from "bun:test";
import { AccessTokenPool, TokenError, createAccessTokenProvider, createClientCredentialsRequest, nextTokenIndex, tokenExpiresAt } from "../src/infrastructure/auth/token-pool.js";

const counter = (prefix = "t") => { let n = 0; return { get calls() { return n; }, request: async () => ({ access_token: `${prefix}${++n}`, expires_in: 3600 }) }; };

describe("token helpers", () => {
  test("rotates indexes and rejects an empty pool", () => {
    expect([0, 1, 2].map(i => nextTokenIndex(i, 3))).toEqual([1, 2, 0]);
    expect(() => nextTokenIndex(0, 0)).toThrow();
  });

  test("expires one minute early, with a floor and a default", () => {
    expect(tokenExpiresAt(1000, 3600)).toBe(1000 + 3540_000);
    expect(tokenExpiresAt(0, "120")).toBe(60_000);
    expect(tokenExpiresAt(0, 10)).toBe(1000);
    expect(tokenExpiresAt(0, undefined)).toBe(3540_000);
  });

  test("TokenError is transient for network failures, 429 and 5xx only", () => {
    expect(new TokenError("x").transient).toBe(true);
    expect(new TokenError("x", 429).transient).toBe(true);
    expect(new TokenError("x", 503).transient).toBe(true);
    expect(new TokenError("x", 401).transient).toBe(false);
  });
});

describe("AccessTokenPool", () => {
  test("rejects an invalid size", () => {
    expect(() => new AccessTokenPool(0, counter().request)).toThrow("positive integer");
  });

  test("fills each slot once and then reuses cached tokens round-robin", async () => {
    const source = counter();
    const pool = new AccessTokenPool(2, source.request, 0);
    expect(await Promise.all([pool.get(), pool.get()])).toEqual(["t1", "t2"]);
    expect(await pool.get()).toBe("t1");
    expect(await pool.get()).toBe("t2");
    expect(source.calls).toBe(2);
  });

  test("shares one in-flight refresh per slot", async () => {
    const source = counter();
    const pool = new AccessTokenPool(1, source.request, 0);
    expect(await Promise.all([pool.get(), pool.get(), pool.get()])).toEqual(["t1", "t1", "t1"]);
    expect(source.calls).toBe(1);
  });

  test("renew replaces only the slot holding the rejected token", async () => {
    const source = counter();
    const pool = new AccessTokenPool(2, source.request, 0);
    await Promise.all([pool.get(), pool.get()]);
    expect(await pool.renew("t2")).toBe("t3");
    expect(await pool.get()).toBe("t1");
    expect(await pool.get()).toBe("t3");
  });

  test("spaces token requests", async () => {
    const times: number[] = [];
    const pool = new AccessTokenPool(2, async () => { times.push(Date.now()); return { access_token: `t${times.length}`, expires_in: 3600 }; }, 60);
    await Promise.all([pool.get(), pool.get()]);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(50);
  });

  test("a failed refresh does not poison later attempts", async () => {
    let fail = true;
    const pool = new AccessTokenPool(1, async () => { if (fail) throw new TokenError("down", 503); return { access_token: "ok", expires_in: 3600 }; }, 0);
    await expect(pool.get()).rejects.toBeInstanceOf(TokenError);
    fail = false;
    expect(await pool.get()).toBe("ok");
  });

  test("provider exposes get and renew", async () => {
    const provider = createAccessTokenProvider(new AccessTokenPool(1, counter().request, 0));
    expect(await provider.getAccessToken()).toBe("t1");
    expect(await provider.renewAccessToken("t1")).toBe("t2");
  });
});

describe("client credentials request", () => {
  const capture = (response: Response) => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetcher = (async (url: string, init: RequestInit) => { seen.url = url; seen.init = init; return response; }) as unknown as typeof fetch;
    return { seen, fetcher };
  };

  test("body style sends credentials in the form (BMW)", async () => {
    const { seen, fetcher } = capture(Response.json({ access_token: "abc", expires_in: 100 }));
    const token = await createClientCredentialsRequest({ tokenUrl: "https://auth/token", clientId: "id", clientSecret: "secret", scope: "machine2machine", fetch: fetcher })();
    expect(token.access_token).toBe("abc");
    const form = seen.init!.body as URLSearchParams;
    expect(form.get("client_id")).toBe("id");
    expect(form.get("client_secret")).toBe("secret");
    expect(form.get("scope")).toBe("machine2machine");
    expect((seen.init!.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test("basic style sends an Authorization header and no secret in the form (Mercedes-Benz)", async () => {
    const { seen, fetcher } = capture(Response.json({ access_token: "abc" }));
    await createClientCredentialsRequest({ tokenUrl: "https://auth/token", clientId: "id", clientSecret: "secret", scope: "openid", authStyle: "basic", fetch: fetcher })();
    const form = seen.init!.body as URLSearchParams;
    expect(form.toString()).toBe("grant_type=client_credentials&scope=openid");
    expect((seen.init!.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
  });

  test("reports HTTP failures with a status and never echoes the secret", async () => {
    const { fetcher } = capture(Response.json({ error_description: "invalid_client" }, { status: 401 }));
    const error = await createClientCredentialsRequest({ tokenUrl: "https://auth/token", clientId: "id", clientSecret: "topsecret", label: "Mercedes", fetch: fetcher })().catch(e => e as TokenError);
    expect(error).toBeInstanceOf(TokenError);
    expect((error as TokenError).status).toBe(401);
    expect((error as TokenError).message).toBe("Mercedes token endpoint returned HTTP 401: invalid_client");
    expect((error as TokenError).message).not.toContain("topsecret");
  });

  test("wraps network failures as transient errors and requires credentials", async () => {
    const fetcher = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const error = await createClientCredentialsRequest({ tokenUrl: "https://auth/token", clientId: "id", clientSecret: "s", fetch: fetcher })().catch(e => e as TokenError);
    expect((error as TokenError).transient).toBe(true);
    await expect(createClientCredentialsRequest({ tokenUrl: "https://auth/token", clientId: "", clientSecret: "" })()).rejects.toThrow("not configured");
  });
});
