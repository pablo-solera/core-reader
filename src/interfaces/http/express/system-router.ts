import express, { Router, type RequestHandler } from "express";
import { checkReadiness } from "../../../application/readiness.js";
import type { ReadinessCheck } from "../../../application/ports/runtime.js";

export function readyHandler(checks: Record<string, ReadinessCheck>): RequestHandler {
  return (req, res, next) => {
    void checkReadiness(checks).then(result => res.status(result.ready ? 200 : 503).json({ status: result.ready ? "ready" : "unavailable", checks: result.checks })).catch(next);
  };
}

export function createSystemRouter(openApi: unknown, docsHtml: string, readyChecks: Record<string, ReadinessCheck>): Router {
  const router = Router();
  router.get("/health", (_req, res) => res.json({ status: "ok" }));
  router.get("/ready", readyHandler(readyChecks));
  router.get("/openapi.json", (_req, res) => res.json(openApi));
  router.get("/docs", (_req, res) => res.type("html").send(docsHtml));
  return router;
}
