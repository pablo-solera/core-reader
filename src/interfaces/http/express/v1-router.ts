import express, { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { capabilitiesSchema, contractVersion, createRequestSchema, requestStatusSchema, type Capability, type ReaderCapabilities, type ReaderInfo, type Resource } from "../../../contract/v1.js";
import type { V1Handlers, ResourceHandlers } from "../../../application/v1-handlers.js";
import { ConflictError, NotFoundError, NotSupportedError, ValidationError } from "../../../domain/errors.js";
import { errorBody } from "./error-middleware.js";

export type V1RouterOptions = {
  reader: string;
  version: string;
  manufacturers: string[];
  capabilities?: ReaderCapabilities;
  handlers: V1Handlers;
};

function deriveCapabilities(handlers: V1Handlers): ReaderCapabilities {
  const capability = (resource?: ResourceHandlers): Capability => ({
    create: Boolean(resource?.create),
    list: Boolean(resource?.list),
    cancel: Boolean(resource?.cancel),
    resume: Boolean(resource?.resume),
    download: Boolean(resource?.download),
  });
  return capabilitiesSchema.parse({ labours: capability(handlers.labours), parts: capability(handlers.parts), models: { options: Boolean(handlers.modelsOptions) } });
}

function unsupported(resource: Resource, action: keyof Capability): never {
  throw new NotSupportedError(`${resource} ${action} is not supported by this reader`, { resource, action });
}
function requireCapability(capability: Capability, resource: Resource, action: keyof Capability) {
  if (!capability[action]) unsupported(resource, action);
}
function withAsync(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => { void handler(req, res).catch(next); };
}
function requireRequestId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ValidationError("requestId must be a UUID");
  return value;
}
function asString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function paramString(value: string | string[] | undefined): string { return Array.isArray(value) ? value[0] ?? "" : value ?? ""; }

const forceSchema = z.object({ force: z.boolean().default(false) });

export function createV1Router(options: V1RouterOptions): Router {
  const router = Router();
  const capabilities = options.capabilities ?? deriveCapabilities(options.handlers);
  const info: ReaderInfo = { reader: options.reader, version: options.version, contractVersion, manufacturers: options.manufacturers, capabilities };
  router.get("/info", (_req, res) => res.json(info));

  const resources: Resource[] = ["labours", "parts"];
  for (const resource of resources) {
    const capability = capabilities[resource];
    const handlers = options.handlers[resource];
    const base = `/${resource}`;
    router.post(base, withAsync(async (req, res) => {
      requireCapability(capability, resource, "create");
      if (!handlers?.create) return unsupported(resource, "create");
      const input = createRequestSchema.parse(req.body);
      const result = await handlers.create(input);
      return res.status(202).json({ requestId: result.requestId, resource, status: "queued", links: { self: `/v1/${resource}/${result.requestId}` } });
    }));
    router.get(base, withAsync(async (req, res) => {
      requireCapability(capability, resource, "list");
      if (!handlers?.list) return unsupported(resource, "list");
      const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("limit must be an integer between 1 and 100");
      const status = typeof req.query.status === "string" ? req.query.status.split(",").map(item => item.trim()).filter(Boolean) : undefined;
      const invalidStatus = status?.find(item => !requestStatusSchema.safeParse(item).success);
      if (invalidStatus) throw new ValidationError(`Invalid status filter: ${invalidStatus}`);
      return res.json(await handlers.list({ status, manufacturer: asString(req.query.manufacturer), axCode: asString(req.query.axCode), edition: asString(req.query.edition), limit, cursor: asString(req.query.cursor) }));
    }));
    router.get(`${base}/:requestId`, withAsync(async (req, res) => {
      const requestId = requireRequestId(paramString(req.params.requestId));
      if (!handlers?.get) throw new NotSupportedError(`${resource} status is not supported by this reader`, { resource, action: "get" });
      const state = await handlers.get(requestId);
      if (!state) throw new NotFoundError(`${resource} request not found`, { requestId });
      return res.json(state);
    }));
    router.get(`${base}/:requestId/download`, withAsync(async (req, res) => {
      requireCapability(capability, resource, "download");
      if (!handlers?.download) return unsupported(resource, "download");
      const requestId = requireRequestId(paramString(req.params.requestId));
      return res.redirect(307, await handlers.download(requestId, asString(req.query.artifact)));
    }));
    router.post(`${base}/:requestId/cancel`, withAsync(async (req, res) => {
      requireCapability(capability, resource, "cancel");
      if (!handlers?.cancel) return unsupported(resource, "cancel");
      const requestId = requireRequestId(paramString(req.params.requestId));
      const result = await handlers.cancel(requestId);
      return res.status(result.status === "cancelling" ? 202 : 200).json(result.body);
    }));
    router.post(`${base}/:requestId/resume`, withAsync(async (req, res) => {
      requireCapability(capability, resource, "resume");
      if (!handlers?.resume) return unsupported(resource, "resume");
      const requestId = requireRequestId(paramString(req.params.requestId));
      const body = forceSchema.parse(req.body ?? {});
      return res.status(202).json(await handlers.resume(requestId, body.force));
    }));
  }

  router.get("/models/options", withAsync(async (req, res) => {
    if (!capabilities.models.options || !options.handlers.modelsOptions) throw new NotSupportedError("Model options are not supported by this reader", { action: "models.options" });
    return res.json(await options.handlers.modelsOptions(req.query as Record<string, unknown>));
  }));
  router.use((_req, _res, next) => next(new NotFoundError("Route not found")));
  return router;
}
