import type { CreateRequest, ModelOptions, RequestPage, RequestState } from "../contract/v1.js";

export type ListRequestQuery = { status?: string[]; manufacturer?: string; axCode?: string; edition?: string; limit: number; cursor?: string };
export type CancelRequestResult = { status: "cancelled" | "cancelling"; body: unknown };

export type CreateRequestHandler = (request: CreateRequest) => Promise<{ requestId: string }>;
export type ListRequestsHandler = (query: ListRequestQuery) => Promise<RequestPage>;
export type GetRequestHandler = (requestId: string) => Promise<RequestState | null>;
export type DownloadArtifactHandler = (requestId: string, artifact?: string) => Promise<string>;
export type CancelRequestHandler = (requestId: string) => Promise<CancelRequestResult>;
export type ResumeRequestHandler = (requestId: string, force: boolean) => Promise<unknown>;
export type ModelOptionsHandler = (query: Record<string, unknown>) => Promise<ModelOptions>;

export type ResourceHandlers = {
  create?: CreateRequestHandler;
  list?: ListRequestsHandler;
  get?: GetRequestHandler;
  download?: DownloadArtifactHandler;
  cancel?: CancelRequestHandler;
  resume?: ResumeRequestHandler;
};

export type V1Handlers = {
  labours?: ResourceHandlers;
  parts?: ResourceHandlers;
  modelsOptions?: ModelOptionsHandler;
};
