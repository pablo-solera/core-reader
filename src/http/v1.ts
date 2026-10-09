import express, { type Request, type RequestHandler, type Response, Router } from "express";
import { ZodError } from "zod";
import { contractVersion, createRequestSchema, requestStatusSchema, type Capability, type ErrorCode, type ReaderCapabilities, type ReaderInfo, type Resource } from "../contract/v1.js";

export class ReaderError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly status: number, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ReaderError";
  }
}

export type V1Handlers = {
  labours?: ResourceHandlers;
  parts?: ResourceHandlers;
  modelsOptions?: (query: Record<string, unknown>) => Promise<unknown>;
};
export type ResourceHandlers = {
  create?: (body: ReturnType<typeof createRequestSchema.parse>) => Promise<unknown>;
  list?: (query: { status?: string[]; manufacturer?: string; axCode?: string; edition?: string; limit: number; cursor?: string }) => Promise<unknown>;
  get?: (requestId: string) => Promise<unknown | null>;
  cancel?: (requestId: string) => Promise<{ statusCode: 200 | 202; body: unknown }>;
  resume?: (requestId: string, force: boolean) => Promise<unknown>;
  download?: (requestId: string, artifact?: string) => Promise<string>;
};

export type V1RouterOptions = {
  reader: string;
  version: string;
  manufacturers: string[];
  capabilities: ReaderCapabilities;
  handlers: V1Handlers;
};

export function errorBody(code: ErrorCode, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export const readerErrorMiddleware: express.ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof ReaderError) return res.status(error.status).json(errorBody(error.code, error.message, error.details));
  const issues = error instanceof ZodError || isZodErrorLike(error) ? error.issues : undefined;
  if (issues) return res.status(400).json(errorBody("VALIDATION_ERROR", issues.map(issue => issue.message).join("; "), { issues }));
  if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") return res.status(413).json(errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the configured size limit"));
  if (error instanceof SyntaxError && "body" in error) return res.status(400).json(errorBody("VALIDATION_ERROR", "Malformed JSON request body"));
  return res.status(500).json(errorBody("INTERNAL_ERROR", error instanceof Error ? error.message : "Internal server error"));
};

function isZodErrorLike(error: unknown): error is ZodError {
  return !!error && typeof error === "object" && "name" in error && error.name === "ZodError" && "issues" in error && Array.isArray(error.issues);
}

export const readerNotFoundMiddleware: RequestHandler = (req, res) => {
  res.status(404).json(errorBody("NOT_FOUND", "Route not found", { path: req.path, method: req.method }));
};

function unsupported(resource: Resource, action: keyof Capability): never {
  throw new ReaderError("NOT_SUPPORTED", `${resource} ${action} is not supported by this reader`, 501, { resource, action });
}
function requireCapability(capability: Capability, resource: Resource, action: keyof Capability) {
  if (!capability[action]) unsupported(resource, action);
}
function withAsync(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => { void handler(req, res).catch(next); };
}
function requireRequestId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ReaderError("VALIDATION_ERROR", "requestId must be a UUID", 400);
  return value;
}
const noHandler = (resource: Resource, action: keyof Capability): never => unsupported(resource, action);

export function createV1Router(options: V1RouterOptions): Router {
  const router = Router();
  const info: ReaderInfo = { reader: options.reader, version: options.version, contractVersion, manufacturers: options.manufacturers, capabilities: options.capabilities };
  router.get("/info", (_req, res) => res.json(info));

  for (const resource of ["labours", "parts"] as const) {
    const capability = options.capabilities[resource];
    const handlers = options.handlers[resource];
    const base = `/${resource}`;

    router.post(base, withAsync(async (req, res) => {
      requireCapability(capability, resource, "create");
      if (!handlers?.create) return noHandler(resource, "create");
      const input = createRequestSchema.parse(req.body);
      const result = await handlers.create(input);
      return res.status(202).json({ requestId: (result as { requestId: string }).requestId, resource, status: "queued", links: { self: `/v1/${resource}/${(result as { requestId: string }).requestId}` } });
    }));

    router.get(base, withAsync(async (req, res) => {
      requireCapability(capability, resource, "list");
      if (!handlers?.list) return noHandler(resource, "list");
      const query = req.query;
      const limit = query.limit === undefined ? 50 : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ReaderError("VALIDATION_ERROR", "limit must be an integer between 1 and 100", 400);
      const status = typeof query.status === "string" ? query.status.split(",").map(item => item.trim()).filter(Boolean) : undefined;
      const invalidStatus = status?.find(item => !requestStatusSchema.safeParse(item).success);
      if (invalidStatus) throw new ReaderError("VALIDATION_ERROR", `Invalid status filter: ${invalidStatus}`, 400);
      return res.json(await handlers.list({ status, manufacturer: asString(query.manufacturer), axCode: asString(query.axCode), edition: asString(query.edition), limit, cursor: asString(query.cursor) }));
    }));

    router.get(`${base}/:requestId`, withAsync(async (req, res) => {
      const requestId = requireRequestId(paramString(req.params.requestId));
      if (!handlers?.get) throw new ReaderError("NOT_SUPPORTED", `${resource} status is not supported by this reader`, 501, { resource, action: "get" });
      const state = await handlers.get(requestId);
      if (!state) throw new ReaderError("NOT_FOUND", `${resource} request not found`, 404, { requestId });
      return res.json(state);
    }));

    router.get(`${base}/:requestId/download`, withAsync(async (req, res) => {
      requireCapability(capability, resource, "download");
      if (!handlers?.download) return noHandler(resource, "download");
      const requestId = requireRequestId(paramString(req.params.requestId));
      const artifact = asString(req.query.artifact);
      const location = await handlers.download(requestId, artifact);
      return res.redirect(307, location);
    }));

    router.post(`${base}/:requestId/cancel`, withAsync(async (req, res) => {
      requireCapability(capability, resource, "cancel");
      if (!handlers?.cancel) return noHandler(resource, "cancel");
      const requestId = requireRequestId(paramString(req.params.requestId));
      const result = await handlers.cancel(requestId);
      return res.status(result.statusCode).json(result.body);
    }));

    router.post(`${base}/:requestId/resume`, withAsync(async (req, res) => {
      requireCapability(capability, resource, "resume");
      if (!handlers?.resume) return noHandler(resource, "resume");
      const requestId = requireRequestId(paramString(req.params.requestId));
      const body = expressBodyForce.parse(req.body ?? {});
      return res.status(202).json(await handlers.resume(requestId, body.force));
    }));
  }

  router.get("/models/options", withAsync(async (req, res) => {
    if (!options.capabilities.models.options || !options.handlers.modelsOptions) throw new ReaderError("NOT_SUPPORTED", "model options are not supported by this reader", 501, { action: "models.options" });
    return res.json(await options.handlers.modelsOptions(req.query as Record<string, unknown>));
  }));
  router.use((_req, _res, next) => next(new ReaderError("NOT_FOUND", "Route not found", 404)));
  return router;
}

const expressBodyForce = {
  parse(value: unknown): { force: boolean } {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReaderError("VALIDATION_ERROR", "resume body must be an object", 400);
    const force = (value as Record<string, unknown>).force;
    if (force !== undefined && typeof force !== "boolean") throw new ReaderError("VALIDATION_ERROR", "force must be a boolean", 400);
    return { force: force ?? false };
  },
};
function asString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function paramString(value: string | string[] | undefined): string { return Array.isArray(value) ? value[0] ?? "" : value ?? ""; }

export function readyHandler(checks: Record<string, () => Promise<unknown>>): RequestHandler {
  return withAsync(async (_req, res) => {
    const outcomes = await Promise.all(Object.entries(checks).map(async ([name, check]) => {
      try { await check(); return [name, "ok"] as const; }
      catch { return [name, "error"] as const; }
    }));
    const values = Object.fromEntries(outcomes);
    const ready = Object.values(values).every(value => value === "ok");
    return res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "unavailable", checks: values });
  });
}

export function createSystemRouter(openApi: unknown, docsHtml: string, readyChecks: Record<string, () => Promise<unknown>>): Router {
  const router = Router();
  router.get("/health", (_req, res) => res.json({ status: "ok" }));
  router.get("/ready", readyHandler(readyChecks));
  router.get("/openapi.json", (_req, res) => res.json(openApi));
  router.get("/docs", (_req, res) => res.type("html").send(docsHtml));
  return router;
}

export function buildOpenApiV1(options: { title: string; version: string; serverUrl: string; selectionSchemas?: Record<string, unknown>; paths?: Record<string, unknown> }) {
  const commonPaths = {
    "/health": {
      get: { tags: ["System"], summary: "Check process liveness", description: "Returns success while the HTTP process is running. This endpoint does not probe external dependencies.", responses: { "200": { description: "The process is alive." } } },
    },
    "/ready": {
      get: { tags: ["System"], summary: "Check service readiness", description: "Checks configured dependencies such as Redis, S3, and the worker heartbeat. A failed check returns 503.", responses: { "200": { description: "All required dependencies are available." }, "503": { description: "At least one required dependency is unavailable." } } },
    },
    "/openapi.json": { get: { tags: ["System"], summary: "Get the OpenAPI document", description: "Returns this reader's generated OpenAPI 3.0.3 specification, including its manufacturer-specific selection schema.", responses: { "200": { description: "OpenAPI specification document." } } } },
    "/docs": { get: { tags: ["System"], summary: "Open interactive API documentation", description: "Serves the Swagger UI for this reader's OpenAPI document.", responses: { "200": { description: "Swagger UI HTML page." } } } },
    "/v1/info": { get: { tags: ["Info"], summary: "Get reader identity and capabilities", description: "Returns the reader name, implementation and contract versions, supported manufacturers, and resource capabilities.", responses: { "200": { description: "Reader identity and capabilities.", content: { "application/json": { schema: { $ref: "#/components/schemas/ReaderInfo" } } } } } } },
    "/v1/labours": {
      get: {
        tags: ["Labours"], summary: "List labour extraction requests", description: "Returns a cursor-paginated list of labour requests retained by this reader. Filters may be combined.",
        parameters: [
          { name: "status", in: "query", description: "Comma-separated v1 request statuses.", schema: { type: "string" } },
          { name: "manufacturer", in: "query", description: "Filter by manufacturer name.", schema: { type: "string" } },
          { name: "axCode", in: "query", description: "Filter by AxCode.", schema: { type: "string" } },
          { name: "edition", in: "query", description: "Filter by edition.", schema: { type: "string" } },
          { name: "limit", in: "query", description: "Maximum number of items to return (1–100).", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
          { name: "cursor", in: "query", description: "Opaque cursor returned by the previous page.", schema: { type: "string" } },
        ],
        responses: { "200": { description: "A page of labour requests.", content: { "application/json": { schema: { $ref: "#/components/schemas/RequestPage" } } } }, "400": { description: "Invalid filter, limit, or cursor." }, "501": { description: "Listing is not supported by this reader." } },
      },
      post: {
        tags: ["Labours"], summary: "Create a labour extraction request", description: "Validates manufacturer-specific selection criteria, queues the extraction, and returns a request ID for polling.",
        requestBody: { required: true, description: "Common request fields plus a manufacturer-specific selection object.", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateRequest" } } } },
        responses: { "202": { description: "The extraction request was queued.", content: { "application/json": { schema: { $ref: "#/components/schemas/Enqueued" } } } }, "400": { description: "The request body or selection is invalid." }, "409": { description: "An identical extraction is already active." }, "501": { description: "Labour extraction is not supported by this reader." } },
      },
    },
    "/v1/labours/{requestId}": { get: { tags: ["Labours"], summary: "Get labour extraction status", description: "Returns the current request status, progress, manufacturer selection, artifacts, and reader-specific operational details.", parameters: [{ name: "requestId", in: "path", required: true, description: "UUID returned when the request was created.", schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Current labour request state.", content: { "application/json": { schema: { $ref: "#/components/schemas/RequestState" } } } }, "400": { description: "The request ID is not a UUID." }, "404": { description: "No labour request exists with this ID." }, "501": { description: "Status lookup is not supported by this reader." } } } },
    "/v1/labours/{requestId}/download": { get: { tags: ["Labours"], summary: "Download a labour artifact", description: "Redirects to a short-lived signed URL. Without artifact, the reader selects its primary artifact; use artifact to select a named file. Prefix artifacts cannot be downloaded as a single file.", parameters: [{ name: "requestId", in: "path", required: true, description: "UUID returned when the request was created.", schema: { type: "string", format: "uuid" } }, { name: "artifact", in: "query", description: "Optional artifact name from the request state.", schema: { type: "string" } }], responses: { "307": { description: "Redirect to a signed artifact URL." }, "400": { description: "The request ID is not a UUID." }, "404": { description: "The request or artifact does not exist." }, "409": { description: "The artifact is not ready, is a prefix, or no primary artifact is available." }, "501": { description: "Downloads are not supported by this reader." } } } },
    "/v1/labours/{requestId}/cancel": { post: { tags: ["Labours"], summary: "Cancel a labour extraction", description: "Requests cancellation, stops further manufacturer calls, and removes incomplete, unshared typekey prefixes from S3. Already completed or concurrently shared typekeys are preserved.", parameters: [{ name: "requestId", in: "path", required: true, description: "UUID returned when the request was created.", schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "The request is cancelled." }, "202": { description: "Cancellation is in progress." }, "400": { description: "The request ID is not a UUID." }, "404": { description: "No labour request exists with this ID." }, "409": { description: "The request cannot be cancelled in its current state." }, "501": { description: "Cancellation is not supported by this reader." } } } },
    "/v1/labours/{requestId}/resume": { post: { tags: ["Labours"], summary: "Resume a labour extraction", description: "Requeues a failed or paused request from the first incomplete typekey, reusing completed data and OID checkpoints.", parameters: [{ name: "requestId", in: "path", required: true, description: "UUID returned when the request was created.", schema: { type: "string", format: "uuid" } }], requestBody: { required: false, description: "Set force only for an operator-authorized recovery when no active worker owns the request.", content: { "application/json": { schema: { type: "object", properties: { force: { type: "boolean", default: false } } } } } }, responses: { "202": { description: "The resumed extraction was queued." }, "400": { description: "The request ID or body is invalid." }, "404": { description: "No resumable labour request exists with this ID." }, "409": { description: "The request is active or cannot be resumed in its current state." }, "501": { description: "Resume is not supported by this reader." } } } },
    "/v1/parts": {
      get: { tags: ["Parts"], summary: "List parts extraction requests", description: "Returns a cursor-paginated list of parts requests when parts listing is supported.", parameters: [{ name: "status", in: "query", description: "Comma-separated v1 request statuses.", schema: { type: "string" } }, { name: "manufacturer", in: "query", description: "Filter by manufacturer name.", schema: { type: "string" } }, { name: "axCode", in: "query", description: "Filter by AxCode.", schema: { type: "string" } }, { name: "edition", in: "query", description: "Filter by edition.", schema: { type: "string" } }, { name: "limit", in: "query", description: "Maximum number of items to return (1–100).", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } }, { name: "cursor", in: "query", description: "Opaque cursor returned by the previous page.", schema: { type: "string" } }], responses: { "200": { description: "A page of parts requests.", content: { "application/json": { schema: { $ref: "#/components/schemas/RequestPage" } } } }, "400": { description: "Invalid filter, limit, or cursor." }, "501": { description: "Parts listing is not supported by this reader." } } },
      post: { tags: ["Parts"], summary: "Create a parts extraction request", description: "Queues a manufacturer-specific parts extraction when supported.", requestBody: { required: true, description: "Common request fields plus manufacturer-specific selection criteria.", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateRequest" } } } }, responses: { "202": { description: "The parts extraction was queued.", content: { "application/json": { schema: { $ref: "#/components/schemas/Enqueued" } } } }, "400": { description: "The request body or selection is invalid." }, "409": { description: "An identical parts extraction is already active." }, "501": { description: "Parts extraction is not supported by this reader." } } },
    },
    "/v1/parts/{requestId}": { get: { tags: ["Parts"], summary: "Get parts extraction status", description: "Returns the current parts request status, progress, artifacts, and reader-specific details.", parameters: [{ name: "requestId", in: "path", required: true, description: "UUID returned when the request was created.", schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Current parts request state.", content: { "application/json": { schema: { $ref: "#/components/schemas/RequestState" } } } }, "400": { description: "The request ID is not a UUID." }, "404": { description: "No parts request exists with this ID." }, "501": { description: "Parts status lookup is not supported by this reader." } } } },
    "/v1/parts/{requestId}/download": { get: { tags: ["Parts"], summary: "Download a parts artifact", description: "Redirects to a short-lived signed URL for the primary artifact or the named artifact selected with the artifact query parameter.", parameters: [{ name: "requestId", in: "path", required: true, description: "UUID returned when the request was created.", schema: { type: "string", format: "uuid" } }, { name: "artifact", in: "query", description: "Optional artifact name from the request state.", schema: { type: "string" } }], responses: { "307": { description: "Redirect to a signed artifact URL." }, "400": { description: "The request ID is not a UUID." }, "404": { description: "The request or artifact does not exist." }, "409": { description: "The artifact is not ready or is not a single downloadable file." }, "501": { description: "Parts downloads are not supported by this reader." } } } },
    "/v1/parts/{requestId}/cancel": { post: { tags: ["Parts"], summary: "Cancel a parts extraction", description: "Requests cancellation of a queued or running parts extraction.", parameters: [{ name: "requestId", in: "path", required: true, description: "UUID returned when the request was created.", schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "The request is cancelled." }, "202": { description: "Cancellation is in progress." }, "400": { description: "The request ID is not a UUID." }, "404": { description: "No parts request exists with this ID." }, "409": { description: "The request cannot be cancelled in its current state." }, "501": { description: "Parts cancellation is not supported by this reader." } } } },
    "/v1/parts/{requestId}/resume": { post: { tags: ["Parts"], summary: "Resume a parts extraction", description: "Requeues a failed or paused parts request when resume is supported.", parameters: [{ name: "requestId", in: "path", required: true, description: "UUID returned when the request was created.", schema: { type: "string", format: "uuid" } }], requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { force: { type: "boolean", default: false } } } } } }, responses: { "202": { description: "The resumed extraction was queued." }, "400": { description: "The request ID or body is invalid." }, "404": { description: "No resumable parts request exists with this ID." }, "409": { description: "The request cannot be resumed in its current state." }, "501": { description: "Parts resume is not supported by this reader." } } } },
    "/v1/models/options": { get: { tags: ["Models"], summary: "Get model and vehicle options", description: "Discovers the manufacturer's model hierarchy. Pass manufacturer and the documented manufacturer-specific filters to retrieve the next set of available filters and selectable models. Each returned model includes a selection object suitable for a labour or parts request.", parameters: [{ name: "manufacturer", in: "query", description: "Manufacturer whose model hierarchy should be queried.", schema: { type: "string" } }, { name: "language", in: "query", description: "Manufacturer API language/locale.", schema: { type: "string" } }, { name: "includeRaw", in: "query", description: "Include the unmodified manufacturer response when true.", schema: { type: "boolean", default: false } }], responses: { "200": { description: "Available filters, models, and reusable selections." }, "400": { description: "The manufacturer or filter combination is invalid." }, "502": { description: "The manufacturer model-discovery service returned an error." }, "501": { description: "Model discovery is not supported by this reader." } } } },
  };
  const artifact = { type: "object", required: ["name", "kind", "primary", "location"], properties: { name: { type: "string" }, kind: { type: "string", enum: ["file", "prefix"] }, contentType: { type: "string" }, size: { type: "integer" }, primary: { type: "boolean" }, location: { type: "object", required: ["bucket", "key"], properties: { bucket: { type: "string" }, key: { type: "string" } } } } };
  const createRequest = { type: "object", required: ["manufacturer", "selection"], properties: { manufacturer: { type: "string" }, axCode: { type: "string" }, edition: { type: "string" }, language: { type: "string" }, selection: { type: "object", additionalProperties: true } } };
  return {
    openapi: "3.0.3",
    info: {
      title: options.title,
      version: options.version,
      description: "Versioned HTTP contract for manufacturer readers. Each reader documents its own manufacturer-specific selection fields under the shared resource and job lifecycle operations.",
    },
    servers: [{ url: options.serverUrl, description: "Reader API base URL" }],
    tags: [
      { name: "System", description: "Process liveness, dependency readiness, and API documentation." },
      { name: "Info", description: "Reader identity, supported manufacturers, and resource capabilities." },
      { name: "Labours", description: "Create, list, inspect, cancel, resume, and download labour-time extraction requests." },
      { name: "Parts", description: "Create, list, inspect, cancel, resume, and download parts extraction requests." },
      { name: "Models", description: "Discover manufacturer model hierarchies and reusable vehicle selections." },
    ],
    paths: { ...commonPaths, ...options.paths },
    components: { schemas: {
      CreateRequest: createRequest,
      Enqueued: { type: "object", required: ["requestId", "resource", "status", "links"], properties: { requestId: { type: "string", format: "uuid" }, resource: { type: "string", enum: ["labours", "parts"] }, status: { type: "string", enum: ["queued"] }, links: { type: "object", properties: { self: { type: "string" } } } } },
      Artifact: artifact,
      RequestState: { type: "object", required: ["requestId", "resource", "reader", "status", "stage", "progress", "request", "artifacts", "error", "createdAt", "updatedAt", "completedAt"], properties: { requestId: { type: "string", format: "uuid" }, resource: { type: "string", enum: ["labours", "parts"] }, reader: { type: "string" }, status: { type: "string", enum: ["queued", "running", "rate_limited", "paused", "cancelling", "cancelled", "completed", "failed"] }, stage: { type: "string" }, progress: { type: "integer", minimum: 0, maximum: 100, nullable: true }, request: { $ref: "#/components/schemas/CreateRequest" }, artifacts: { type: "array", items: { $ref: "#/components/schemas/Artifact" } }, error: { type: "object", nullable: true, properties: { code: { type: "string" }, message: { type: "string" } } }, details: { type: "object", additionalProperties: true }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" }, completedAt: { type: "string", format: "date-time", nullable: true } } },
      ErrorBody: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, details: { type: "object", additionalProperties: true } } } } },
      ...(options.selectionSchemas ?? {}),
    } },
  } as const;
}
