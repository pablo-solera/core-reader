export type EnqueueOptions = { jobId: string; attempts?: number; backoffMs?: number; removeOnComplete?: boolean; removeOnFail?: number };
export type QueueJob<TData, TResult = unknown> = { id: string; data: TData; state: string; attemptsMade: number; result?: TResult };

export interface JobQueue<TData, TResult = unknown> {
  add(name: string, data: TData, options: EnqueueOptions): Promise<{ id: string }>;
  get(jobId: string): Promise<QueueJob<TData, TResult> | null>;
  remove(jobId: string): Promise<void>;
  getCounts(...states: string[]): Promise<Record<string, number>>;
}

export interface JobWorker<TData, TResult = unknown> {
  close(force?: boolean): Promise<void>;
  pause(doNotWaitActive?: boolean): Promise<void>;
  resume(): Promise<void>;
  on(event: "ready" | "error", listener: (...args: never[]) => void): this;
  on(event: "completed", listener: (job: QueueJob<TData, TResult>, result: TResult) => void): this;
  on(event: "failed", listener: (job: QueueJob<TData, TResult> | undefined, error: Error) => void): this;
}
