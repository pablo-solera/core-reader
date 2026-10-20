import { describe, expect, test } from "bun:test";
import { createRequestSchema, errorBodySchema, toRequestStatus, v1Paths } from "../src/contract/v1.js";
import { generateOpenApiV1 } from "../src/contract/openapi.js";
import { createV1Router } from "../src/interfaces/http/express/v1-router.js";
import { assertV1RouteInventory } from "../src/testing/conformance.js";
import express from "express";
import { RedisStateStore, type StateRedis } from "../src/infrastructure/redis/state-store.js";

describe("reader API v1 contract", () => {
  test("validates common request fields and keeps manufacturer selection open", () => {
    expect(createRequestSchema.parse({ manufacturer: "BMW", selection: { typekeys: ["11EH"] } })).toEqual({ manufacturer: "BMW", selection: { typekeys: ["11EH"] } });
    expect(createRequestSchema.safeParse({ manufacturer: "", selection: {} }).success).toBe(false);
    expect(createRequestSchema.safeParse({ manufacturer: "BMW" }).success).toBe(false);
  });

  test("maps legacy worker statuses to v1 statuses", () => {
    expect(["downloading", "rate-limited", "paused", "completed", "failed"].map(toRequestStatus)).toEqual(["running", "rate_limited", "paused", "completed", "failed"]);
  });

  test("normalizes errors with stable code and message fields", () => {
    expect(errorBodySchema.parse({ error: { code: "NOT_READY", message: "Not ready", details: { status: "queued" } } })).toBeTruthy();
  });

  test("mounts the normative v1 route inventory", () => {
    const router = createV1Router({
      reader: "test", version: "0.1.0", manufacturers: [],
      handlers: {},
    });
    expect(assertV1RouteInventory(router, "/v1")).toEqual([]);
    expect(v1Paths).toHaveLength(14);
  });

  test("documents the full route surface and supports brand schemas", () => {
    const spec = generateOpenApiV1({ title: "BMW Reader API", version: "1.0.0", serverUrl: "http://localhost:3004", selectionSchemas: { BmwSelection: { type: "object" } } });
    expect(Object.keys(spec.paths)).toHaveLength(16);
    expect((spec.paths as Record<string, unknown>)["/v1/metrics/throughput"]).toBeUndefined();
    expect((spec.components?.schemas as Record<string, unknown>)?.BmwSelection).toBeDefined();
    expect(spec.paths["/v1/labours/{requestId}/download"]).toBeDefined();
  });

  test("groups every documented operation by tag with English summaries and descriptions", () => {
    const spec = generateOpenApiV1({ title: "Reader API", version: "1.0.0", serverUrl: "http://localhost:3000" });
    const paths = spec.paths as Record<string, Record<string, { tags?: string[]; summary?: string; description?: string }>>;
    const operations = Object.values(paths).flatMap(pathItem => Object.entries(pathItem).filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method)).map(([, operation]) => operation));
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) {
      expect(Boolean(operation.tags?.length)).toBe(true);
      expect(operation.summary).toBeTruthy();
      expect(operation.description).toBeTruthy();
      expect(operation.summary).toMatch(/^[A-Za-z0-9]/);
    }
  });

  test("generates all referenced OpenAPI components from the zod registry", () => {
    const spec = generateOpenApiV1({ title: "Reader API", version: "1.0.0", serverUrl: "http://localhost:3000" });
    const components = spec.components?.schemas ?? {};
    const missing: string[] = [];
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      if ("$ref" in value && typeof value.$ref === "string" && value.$ref.startsWith("#/components/schemas/")) {
        const name = value.$ref.slice("#/components/schemas/".length);
        if (!(name in components)) missing.push(name);
      }
      for (const child of Object.values(value)) visit(child);
    }
    visit(spec.paths);
    expect(missing).toEqual([]);
  });

  test("state patches carry empty-array preservation and compare guards to the atomic Redis script", async () => {
    const calls: Array<{ script: string; args: Array<string | number> }> = [];
    let current = { updatedAt: "before", status: "queued", typekeyPaths: ["one"] as string[] };
    const redis: StateRedis = {
      async get() { return JSON.stringify(current); },
      async set() { return "OK"; },
      async eval(script, _keyCount, ...args) {
        calls.push({ script, args });
        const conditions = JSON.parse(String(args[5])) as Record<string, unknown>;
        if (Object.entries(conditions).some(([key, value]) => current[key as keyof typeof current] !== value)) return false;
        current = { ...current, ...JSON.parse(String(args[1])), updatedAt: String(args[3]) };
        return JSON.stringify(current);
      },
    };
    const store = new RedisStateStore<{ updatedAt: string; status: string; typekeyPaths: string[] }>(redis, id => `state:${id}`, 60);
    const updated = await store.patch("job", { typekeyPaths: [] }, [], { status: "queued" });
    expect(updated?.typekeyPaths).toEqual([]);
    expect(calls[0]?.script).toContain("protectEmptyArrays");
    expect(calls[0]?.script).toContain("return false");
    expect(JSON.parse(String(calls[0]?.args[5]))).toEqual({ status: "queued" });
    expect(String(calls[0]?.args[6])).toMatch(/^[\da-f-]{36}$/);
    current = { ...current, status: "cancelling" };
    expect(await store.patch("job", { status: "rate-limited" }, [], { status: "downloading" })).toBeNull();
    expect(current.status).toBe("cancelling");
  });
});
