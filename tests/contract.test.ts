import { describe, expect, test } from "bun:test";
import { createRequestSchema, errorBodySchema, toRequestStatus, v1Paths } from "../src/contract/v1.js";
import { buildOpenApiV1, createV1Router } from "../src/http/v1.js";
import { assertV1RouteInventory } from "../src/testing/conformance.js";
import express from "express";

const noCapability = { create: false, list: false, cancel: false, resume: false, download: false };

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
      capabilities: { labours: noCapability, parts: noCapability, models: { options: false } },
      handlers: {},
    });
    expect(assertV1RouteInventory(router, "/v1")).toEqual([]);
    expect(v1Paths).toHaveLength(14);
  });

  test("documents the full route surface and supports brand schemas", () => {
    const spec = buildOpenApiV1({ title: "BMW Reader API", version: "1.0.0", serverUrl: "http://localhost:3004", selectionSchemas: { BmwSelection: { type: "object" } } });
    expect(Object.keys(spec.paths)).toHaveLength(16);
    expect((spec.paths as Record<string, unknown>)["/v1/metrics/throughput"]).toBeUndefined();
    expect((spec.components.schemas as Record<string, unknown>).BmwSelection).toEqual({ type: "object" });
    expect(spec.paths["/v1/labours/{requestId}/download"]).toBeDefined();
  });

  test("groups every documented operation by tag with English summaries and descriptions", () => {
    const spec = buildOpenApiV1({ title: "Reader API", version: "1.0.0", serverUrl: "http://localhost:3000" });
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
});
