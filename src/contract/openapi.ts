import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  artifactSchema,
  capabilitiesSchema,
  createRequestSchema,
  enqueuedSchema,
  errorBodySchema,
  modelOptionsSchema,
  readerInfoSchema,
  requestPageSchema,
  requestStateSchema,
  requestSummarySchema,
} from "./v1.js";

extendZodWithOpenApi(z);

const commonPaths = {
  "/health": { get: { tags: ["System"], summary: "Check process liveness", description: "Returns success while the HTTP process is running. This endpoint does not probe external dependencies.", responses: { "200": { description: "The process is alive." } } } },
  "/ready": { get: { tags: ["System"], summary: "Check service readiness", description: "Checks configured dependencies. A failed check returns 503 with the same status/checks response shape.", responses: { "200": { description: "All required dependencies are available." }, "503": { description: "At least one required dependency is unavailable." } } } },
  "/openapi.json": { get: { tags: ["System"], summary: "Get the OpenAPI document", description: "Returns this reader's generated OpenAPI specification.", responses: { "200": { description: "OpenAPI specification document." } } } },
  "/docs": { get: { tags: ["System"], summary: "Open interactive API documentation", description: "Serves the Swagger UI for this reader's OpenAPI document.", responses: { "200": { description: "Swagger UI HTML page." } } } },
  "/v1/info": { get: { tags: ["Info"], summary: "Get reader identity and capabilities", description: "Returns reader identity, version, manufacturers, and supported resources.", responses: { "200": { description: "Reader information.", content: { "application/json": { schema: { $ref: "#/components/schemas/ReaderInfo" } } } } } } },
  "/v1/labours": {
    get: { tags: ["Labours"], summary: "List labour extraction requests", description: "Returns a cursor-paginated page of labour requests.", parameters: [{ name: "status", in: "query", schema: { type: "string" } }, { name: "manufacturer", in: "query", schema: { type: "string" } }, { name: "axCode", in: "query", schema: { type: "string" } }, { name: "edition", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } }, { name: "cursor", in: "query", schema: { type: "string" } }], responses: { "200": { description: "A page of labour requests.", content: { "application/json": { schema: { $ref: "#/components/schemas/RequestPage" } } } }, "400": { description: "Invalid filters." }, "501": { description: "Listing is not supported." } } },
    post: { tags: ["Labours"], summary: "Create a labour extraction request", description: "Queues a manufacturer-specific labour extraction.", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateRequest" } } } }, responses: { "202": { description: "The extraction was queued.", content: { "application/json": { schema: { $ref: "#/components/schemas/Enqueued" } } } }, "400": { description: "Invalid request." }, "409": { description: "A conflicting request exists." }, "501": { description: "Labour extraction is not supported." } } },
  },
  "/v1/labours/{requestId}": { get: { tags: ["Labours"], summary: "Get labour extraction status", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Request state.", content: { "application/json": { schema: { $ref: "#/components/schemas/RequestState" } } } }, "400": { description: "Invalid request ID." }, "404": { description: "Request not found." } } } },
  "/v1/labours/{requestId}/download": { get: { tags: ["Labours"], summary: "Download a labour artifact", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { name: "artifact", in: "query", schema: { type: "string" } }], responses: { "307": { description: "Redirect to a signed download URL." }, "404": { description: "Artifact not found." }, "409": { description: "Artifact not ready or not a downloadable file." } } } },
  "/v1/labours/{requestId}/cancel": { post: { tags: ["Labours"], summary: "Cancel a labour extraction", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Request cancelled." }, "202": { description: "Cancellation is in progress." }, "404": { description: "Request not found." }, "409": { description: "Request cannot be cancelled." } } } },
  "/v1/labours/{requestId}/resume": { post: { tags: ["Labours"], summary: "Resume a labour extraction", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: false, content: { "application/json": { schema: z.object({ force: z.boolean().default(false) }) } } }, responses: { "202": { description: "The request was queued for resume." }, "404": { description: "No resumable request exists." }, "409": { description: "The request cannot be resumed." } } } },
  "/v1/parts": {
    get: { tags: ["Parts"], summary: "List parts extraction requests", responses: { "200": { description: "A page of parts requests.", content: { "application/json": { schema: { $ref: "#/components/schemas/RequestPage" } } } }, "501": { description: "Parts listing is not supported." } } },
    post: { tags: ["Parts"], summary: "Create a parts extraction request", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateRequest" } } } }, responses: { "202": { description: "The extraction was queued." }, "501": { description: "Parts extraction is not supported." } } },
  },
  "/v1/parts/{requestId}": { get: { tags: ["Parts"], summary: "Get parts extraction status", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Request state.", content: { "application/json": { schema: { $ref: "#/components/schemas/RequestState" } } } }, "404": { description: "Request not found." } } } },
  "/v1/parts/{requestId}/download": { get: { tags: ["Parts"], summary: "Download a parts artifact", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "307": { description: "Redirect to a signed download URL." }, "501": { description: "Download is not supported." } } } },
  "/v1/parts/{requestId}/cancel": { post: { tags: ["Parts"], summary: "Cancel a parts extraction", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Request cancelled." }, "202": { description: "Cancellation is in progress." }, "501": { description: "Cancellation is not supported." } } } },
  "/v1/parts/{requestId}/resume": { post: { tags: ["Parts"], summary: "Resume a parts extraction", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], requestBody: { required: false, content: { "application/json": { schema: z.object({ force: z.boolean().default(false) }) } } }, responses: { "202": { description: "The request was queued for resume." }, "501": { description: "Resume is not supported." } } } },
  "/v1/models/options": { get: { tags: ["Models"], summary: "Get model and vehicle options", description: "Discovers manufacturer models and returns reusable selection criteria.", parameters: [{ name: "manufacturer", in: "query", schema: { type: "string" } }, { name: "language", in: "query", schema: { type: "string" } }, { name: "includeRaw", in: "query", schema: { type: "boolean" } }], responses: { "200": { description: "Available filters and models.", content: { "application/json": { schema: { $ref: "#/components/schemas/ModelOptions" } } } }, "400": { description: "Invalid filter combination." }, "502": { description: "The upstream model service failed." } } } },
};

export type OpenApiPathItem = Record<string, unknown>;

export function generateOpenApiV1(options: { title: string; version: string; serverUrl: string; selectionSchemas?: Record<string, unknown>; paths?: Record<string, OpenApiPathItem> }) {
  const registry = new OpenAPIRegistry();
  registry.register("Artifact", artifactSchema);
  registry.register("CreateRequest", createRequestSchema);
  registry.register("Enqueued", enqueuedSchema);
  registry.register("ErrorBody", errorBodySchema);
  registry.register("ModelOptions", modelOptionsSchema);
  registry.register("ReaderCapabilities", capabilitiesSchema);
  registry.register("ReaderInfo", readerInfoSchema);
  registry.register("RequestPage", requestPageSchema);
  registry.register("RequestState", requestStateSchema);
  registry.register("RequestSummary", requestSummarySchema);
  for (const [name, schema] of Object.entries(options.selectionSchemas ?? {})) registry.registerComponent("schemas", name, schema as never);
  const generator = new OpenApiGeneratorV3(registry.definitions);
  const generated = generator.generateDocument({
    openapi: "3.0.3",
    info: { title: options.title, version: options.version, description: "Versioned API contract shared by manufacturer readers." },
    servers: [{ url: options.serverUrl, description: "Reader API base URL" }],
    tags: [
      { name: "System", description: "Process liveness, dependency readiness, and API documentation." },
      { name: "Info", description: "Reader identity, supported manufacturers, and resource capabilities." },
      { name: "Labours", description: "Create, list, inspect, cancel, resume, and download labour extraction requests." },
      { name: "Parts", description: "Create, list, inspect, cancel, resume, and download parts extraction requests." },
      { name: "Models", description: "Discover manufacturer model hierarchies and reusable selections." },
    ],
  });
  const paths = { ...commonPaths, ...(options.paths ?? {}) } as Record<string, Record<string, Record<string, unknown>>>;
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      operation.tags ??= [path.startsWith("/v1/labours") ? "Labours" : path.startsWith("/v1/parts") ? "Parts" : path.startsWith("/v1/models") ? "Models" : "System"];
      operation.summary ??= `${method.toUpperCase()} ${path}`;
      operation.description ??= `Executes the ${method.toUpperCase()} operation for ${path}.`;
    }
  }
  return {
    ...generated,
    paths,
  };
}
