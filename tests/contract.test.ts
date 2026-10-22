import { describe, expect, test } from "bun:test";
import { createRequestSchema, errorBodySchema, toRequestStatus, v1Paths } from "../src/contract/v1.js";
import { generateOpenApiV1 } from "../src/contract/openapi.js";
import { NotAvailableError } from "../src/domain/errors.js";
import { mapApplicationError } from "../src/interfaces/http/express/error-middleware.js";
import { createV1Router } from "../src/interfaces/http/express/v1-router.js";
import { assertV1RouteInventory } from "../src/testing/conformance.js";
import express from "express";
import { RedisStateStore, type StateRedis } from "../src/infrastructure/redis/state-store.js";
import { S3Store, type S3Adapter } from "../src/infrastructure/s3/object-storage.js";

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

  test("maps NOT_AVAILABLE to HTTP 422 with structured details", () => {
    const mapped = mapApplicationError(new NotAvailableError("Typekey is not available", { typekeys: [{ typekey: "YM13" }] }));
    expect(mapped).toEqual({ code: "NOT_AVAILABLE", status: 422, message: "Typekey is not available", details: { typekeys: [{ typekey: "YM13" }] } });
    expect(errorBodySchema.parse({ error: { code: "NOT_AVAILABLE", message: "x" } })).toBeTruthy();
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

  test("state patches preserve arrays and compare guards across optimistic Redis retries", async () => {
    let current = { updatedAt: "before", status: "queued", stage: "queued", typekeyPaths: ["one"] as string[] };
    let staged: string | undefined;
    let conflictOnce = true;
    let unwatchCount = 0;
    const redis: StateRedis = {
      async get() { return JSON.stringify(current); },
      async set() { return "OK"; },
      async watch() { return "OK"; },
      async unwatch() { unwatchCount++; return "OK"; },
      multi() {
        return {
          set(_key, value) { staged = value; return this; },
          async exec() {
            if (conflictOnce) {
              conflictOnce = false;
              current = { ...current, stage: "external-update" };
              return null;
            }
            current = JSON.parse(staged!) as typeof current;
            return [[null, "OK"]];
          },
        };
      },
    };
    const store = new RedisStateStore<{ updatedAt: string; status: string; stage: string; typekeyPaths: string[] }>(redis, id => `state:${id}`, 60);
    const updated = await store.patch("job", { typekeyPaths: [] }, [], { status: "queued" });
    expect(updated?.typekeyPaths).toEqual([]);
    expect(updated?.stage).toBe("external-update");
    expect(updated?.updatedAt).not.toBe("before");
    current = { ...current, status: "cancelling" };
    expect(await store.patch("job", { status: "rate-limited" }, [], { status: "downloading" })).toBeNull();
    expect(current.status).toBe("cancelling");
    expect(unwatchCount).toBe(1);
  });

  test("bulk-deletes S3 prefixes in provider-sized batches and keeps the adapter fallback", async () => {
    const batchSizes: number[] = [];
    let individualDeletes = 0;
    const adapter: S3Adapter = {
      async headBucket() {},
      async putObject() {},
      async getObject() { return undefined; },
      async signGet() { return "url"; },
      async list() { return { keys: Array.from({ length: 1101 }, (_, index) => `prefix/${index}`) }; },
      async deleteObject() { individualDeletes++; },
      async deleteObjects(keys) { batchSizes.push(keys.length); },
    };
    const store = new S3Store({ adapter });
    expect(await store.deletePrefix("prefix", value => value === "prefix")).toBe(1101);
    expect(batchSizes).toEqual([1000, 101]);
    expect(individualDeletes).toBe(0);

    const fallbackDeletes: string[] = [];
    const fallback: S3Adapter = {
      async headBucket() {}, async putObject() {}, async getObject() { return undefined; }, async signGet() { return "url"; },
      async list() { return { keys: ["prefix/a", "prefix/b"] }; },
      async deleteObject(key) { fallbackDeletes.push(key); },
    };
    await new S3Store({ adapter: fallback }).deletePrefix("prefix", () => true);
    expect(fallbackDeletes).toEqual(["prefix/a", "prefix/b"]);

    const failedBulkSizes: number[] = [];
    const retriedDeletes: string[] = [];
    const incompatible: S3Adapter = {
      async headBucket() {}, async putObject() {}, async getObject() { return undefined; }, async signGet() { return "url"; },
      async list() { return { keys: Array.from({ length: 1025 }, (_, index) => `prefix/${index}`) }; },
      async deleteObject(key) { retriedDeletes.push(key); },
      async deleteObjects(keys) { failedBulkSizes.push(keys.length); throw new Error("Content-MD5 required"); },
    };
    expect(await new S3Store({ adapter: incompatible }).deletePrefix("prefix", () => true)).toBe(1025);
    expect(failedBulkSizes).toEqual([1000]);
    expect(retriedDeletes).toHaveLength(1025);
  });
});
