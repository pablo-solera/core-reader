import type { Artifact, CreateRequest, ModelOptions, RequestPage, RequestState, RequestSummary } from "../contract/v1.js";

export type ListRequestQuery = { status?: string[]; manufacturer?: string; axCode?: string; edition?: string; limit: number; cursor?: string };
export type CancelRequestResult = { status: "cancelled" | "cancelling"; body: unknown };

export interface CreateRequestHandler { execute(request: CreateRequest): Promise<{ requestId: string }>; }
export interface ListRequestsHandler { execute(query: ListRequestQuery): Promise<RequestPage>; }
export interface GetRequestHandler { execute(requestId: string): Promise<RequestState | null>; }
export interface DownloadArtifactHandler { execute(requestId: string, artifact?: string): Promise<string>; }
export interface CancelRequestHandler { execute(requestId: string): Promise<CancelRequestResult>; }
export interface ResumeRequestHandler { execute(requestId: string, force: boolean): Promise<unknown>; }
export interface ModelOptionsHandler { execute(query: Record<string, unknown>): Promise<ModelOptions>; }

export type ResourceHandlers = {
  create?: CreateRequestHandler["execute"];
  list?: ListRequestsHandler["execute"];
  get?: GetRequestHandler["execute"];
  download?: DownloadArtifactHandler["execute"];
  cancel?: CancelRequestHandler["execute"];
  resume?: ResumeRequestHandler["execute"];
};

export type V1Handlers = {
  labours?: ResourceHandlers;
  parts?: ResourceHandlers;
  modelsOptions?: ModelOptionsHandler["execute"];
};

export type V1HandlerResult = RequestState | RequestPage | RequestSummary | Artifact | ModelOptions | unknown;
