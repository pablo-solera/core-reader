import type { Express, Router } from "express";
import { errorBodySchema, v1Paths } from "../contract/v1.js";

export type ConformanceFailure = { name: string; message: string };

/** Checks the mounted Express paths against the normative v1 route inventory. */
type RouteLayer = { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: RouteLayer[] }; regexp?: RegExp };

export function collectV1Routes(app: Express | Router, prefix = ""): string[] {
  const root = app as unknown as { router?: { stack?: RouteLayer[] }; stack?: RouteLayer[] };
  const stack = root.router?.stack ?? root.stack ?? [];
  return stack.flatMap(layer => {
    if (layer.route) return Object.entries(layer.route.methods)
      .filter(([, enabled]) => enabled)
      .map(([method]) => `${method.toLowerCase()} ${prefix}${layer.route!.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`)
      .filter(route => route.includes("/v1/"));
    if (!layer.handle?.stack) return [];
    const childPrefix = layer.regexp?.source.includes("\\/v1") ? "/v1" : prefix;
    return collectStack(layer.handle.stack, childPrefix);
  });
}

function collectStack(stack: RouteLayer[], prefix: string): string[] {
  return stack.flatMap(layer => {
    if (layer.route) return Object.entries(layer.route.methods)
      .filter(([, enabled]) => enabled)
      .map(([method]) => `${method.toLowerCase()} ${prefix}${layer.route!.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`)
      .filter(route => route.includes("/v1/"));
    if (!layer.handle?.stack) return [];
    const source = layer.regexp?.source ?? "";
    const mountedPrefix = source.includes("\\/v1") ? "/v1" : "";
    return collectStack(layer.handle.stack, `${prefix}${mountedPrefix}`);
  });
}

export function assertV1RouteInventory(app: Express | Router, prefix = ""): ConformanceFailure[] {
  const actual = collectV1Routes(app, prefix).sort();
  const expected = [...v1Paths].sort();
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? []
    : [{ name: "v1 routes", message: `Expected ${expected.join(", ")}; got ${actual.join(", ")}` }];
}

/** Runs shared wire-format checks against a running reader URL. */
export async function checkV1HttpConformance(baseUrl: string, fetcher: typeof fetch = fetch): Promise<ConformanceFailure[]> {
  const failures: ConformanceFailure[] = [];
  const info = await fetcher(new URL("/v1/info", baseUrl));
  if (!info.ok) failures.push({ name: "GET /v1/info", message: `Expected 2xx, got ${info.status}` });

  for (const resource of ["labours", "parts"]) {
    const response = await fetcher(new URL(`/v1/${resource}/not-a-uuid`, baseUrl));
    if (response.status !== 400) failures.push({ name: `${resource} UUID validation`, message: `Expected 400, got ${response.status}` });
    else {
      const body: unknown = await response.json();
      if (!errorBodySchema.safeParse(body).success) failures.push({ name: `${resource} error envelope`, message: "Expected {error:{code,message,details?}}" });
    }
  }
  const specResponse = await fetcher(new URL("/openapi.json", baseUrl));
  if (!specResponse.ok) failures.push({ name: "GET /openapi.json", message: `Expected 2xx, got ${specResponse.status}` });
  else {
    const spec = await specResponse.json() as { paths?: Record<string, Record<string, unknown>> };
    const expectedPaths = new Set(v1Paths);
    const actualPaths = new Set<string>();
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const method of Object.keys(item)) if (["get", "post", "put", "patch", "delete"].includes(method)) actualPaths.add(`${method} ${path}`);
    }
    for (const path of expectedPaths) if (!actualPaths.has(path)) failures.push({ name: "OpenAPI inventory", message: `Missing ${path}` });
  }
  return failures;
}
