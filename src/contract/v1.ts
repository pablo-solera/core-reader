import { z } from "zod";

export const contractVersion = "1.0.0" as const;

export const errorCodeSchema = z.enum([
  "VALIDATION_ERROR", "NOT_FOUND", "CONFLICT", "NOT_READY", "NOT_DOWNLOADABLE",
  "PAYLOAD_TOO_LARGE", "NOT_SUPPORTED", "UPSTREAM_ERROR", "UNAVAILABLE", "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorBodySchema = z.object({
  error: z.object({ code: errorCodeSchema, message: z.string(), details: z.record(z.unknown()).optional() }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

export const createRequestSchema = z.object({
  manufacturer: z.string().trim().min(1),
  axCode: z.string().trim().min(1).optional(),
  edition: z.string().trim().min(1).optional(),
  language: z.string().trim().min(1).optional(),
  selection: z.record(z.unknown()),
});
export type CreateRequest = z.infer<typeof createRequestSchema>;

export const resourceSchema = z.enum(["labours", "parts"]);
export type Resource = z.infer<typeof resourceSchema>;
export const requestStatusSchema = z.enum(["queued", "running", "rate_limited", "paused", "cancelling", "cancelled", "completed", "failed"]);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

export const artifactSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["file", "prefix"]),
  contentType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  primary: z.boolean(),
  location: z.object({ bucket: z.string().min(1), key: z.string().min(1) }),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const requestStateSchema = z.object({
  requestId: z.string().uuid(),
  resource: resourceSchema,
  reader: z.string().min(1),
  status: requestStatusSchema,
  stage: z.string(),
  progress: z.number().int().min(0).max(100).nullable(),
  request: createRequestSchema,
  artifacts: z.array(artifactSchema),
  error: z.object({ code: errorCodeSchema, message: z.string() }).nullable(),
  details: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type RequestState = z.infer<typeof requestStateSchema>;

export const enqueuedSchema = z.object({
  requestId: z.string().uuid(), resource: resourceSchema, status: z.literal("queued"), links: z.object({ self: z.string() }),
});
export type Enqueued = z.infer<typeof enqueuedSchema>;

export const requestSummarySchema = requestStateSchema.omit({ details: true, artifacts: true }).extend({ artifactCount: z.number().int().nonnegative() });
export type RequestSummary = z.infer<typeof requestSummarySchema>;
export const requestPageSchema = z.object({ items: z.array(requestSummarySchema), nextCursor: z.string().nullable() });
export type RequestPage = z.infer<typeof requestPageSchema>;

export const capabilitiesSchema = z.object({
  labours: z.object({ create: z.boolean(), list: z.boolean(), cancel: z.boolean(), resume: z.boolean(), download: z.boolean() }),
  parts: z.object({ create: z.boolean(), list: z.boolean(), cancel: z.boolean(), resume: z.boolean(), download: z.boolean() }),
  models: z.object({ options: z.boolean() }),
});
export const readerInfoSchema = z.object({
  reader: z.string().min(1), version: z.string().min(1), contractVersion: z.literal(contractVersion),
  manufacturers: z.array(z.string()), capabilities: capabilitiesSchema,
});

export const modelOptionsSchema = z.object({
  manufacturer: z.string(),
  appliedFilters: z.record(z.string()),
  filters: z.array(z.object({ name: z.string(), label: z.string().optional(), values: z.array(z.object({ value: z.string(), label: z.string().optional(), count: z.number().optional() })) })),
  models: z.array(z.object({ id: z.string(), label: z.string(), attributes: z.record(z.unknown()), selection: z.record(z.unknown()) })),
  complete: z.boolean(),
  raw: z.unknown().optional(),
});
export type ModelOptions = z.infer<typeof modelOptionsSchema>;

export type Capability = { create: boolean; list: boolean; cancel: boolean; resume: boolean; download: boolean };
export type ReaderCapabilities = { labours: Capability; parts: Capability; models: { options: boolean } };
export type ReaderInfo = { reader: string; version: string; contractVersion: typeof contractVersion; manufacturers: string[]; capabilities: ReaderCapabilities };

export function toRequestStatus(status: string): RequestStatus {
  switch (status) {
    case "queued": return "queued";
    case "downloading":
    case "resolving":
    case "extracting":
    case "loading":
    case "pivoting":
    case "reporting": return "running";
    case "rate-limited":
    case "rate_limited": return "rate_limited";
    case "paused": return "paused";
    case "cancelling": return "cancelling";
    case "cancelled": return "cancelled";
    case "completed": return "completed";
    case "failed": return "failed";
    default: return "running";
  }
}

export const v1Paths = [
  "get /v1/info",
  "get /v1/labours", "post /v1/labours", "get /v1/labours/{requestId}", "get /v1/labours/{requestId}/download", "post /v1/labours/{requestId}/cancel", "post /v1/labours/{requestId}/resume",
  "get /v1/parts", "post /v1/parts", "get /v1/parts/{requestId}", "get /v1/parts/{requestId}/download", "post /v1/parts/{requestId}/cancel", "post /v1/parts/{requestId}/resume",
  "get /v1/models/options",
] as const;
