import type { Job, QueueOptions } from "bullmq";
import type { EnqueueOptions, JobQueue, QueueJob } from "../../application/ports/job-queue.js";

export type BullMqConnectionOptions = QueueOptions;
export type BullMqQueueClient<TData, TResult> = {
  add(name: string, data: TData, options: Record<string, unknown>): Promise<Job<TData, TResult>>;
  getJob(jobId: string): Promise<Job<TData, TResult> | undefined>;
  close(): Promise<void>;
  getJobCounts(...states: string[]): Promise<Record<string, number>>;
};

function queueJob<TData, TResult>(job: Job<TData, TResult>): QueueJob<TData, TResult> {
  return { id: String(job.id), data: job.data, state: "unknown", attemptsMade: job.attemptsMade, result: job.returnvalue };
}

export type BullMqWorkerProcessor<TData, TResult> = (job: Job<TData, TResult>) => Promise<TResult>;

export async function createBullMqJobQueue<TData, TResult = unknown>(name: string, options?: BullMqConnectionOptions): Promise<JobQueue<TData, TResult> & { close(): Promise<void> }> {
  const queue = await createBullMqQueue<TData, TResult>(name, options);
  return {
    async add(jobName, data, settings) {
      const job = await queue.add(jobName, data, {
        jobId: settings.jobId,
        attempts: settings.attempts,
        backoff: settings.backoffMs === undefined ? undefined : { type: "exponential", delay: settings.backoffMs },
        removeOnComplete: settings.removeOnComplete,
        removeOnFail: settings.removeOnFail,
      });
      return { id: String(job.id) };
    },
    async get(jobId) {
      const job = await queue.getJob(jobId);
      if (!job) return null;
      return { id: String(job.id), data: job.data, state: await job.getState(), attemptsMade: job.attemptsMade, result: job.returnvalue };
    },
    async remove(jobId) { const job = await queue.getJob(jobId); if (job) await job.remove(); },
    close: () => queue.close(),
    getCounts: (...states) => queue.getJobCounts(...states),
  };
}

export async function createBullMqQueue<TData = unknown, TResult = unknown>(name: string, options?: BullMqConnectionOptions): Promise<BullMqQueueClient<TData, TResult>> {
  const { Queue } = await import("bullmq");
  return new Queue<TData, TResult, string>(name, options) as unknown as BullMqQueueClient<TData, TResult>;
}

export async function createBullMqWorker<TData, TResult>(queueName: string, processor: BullMqWorkerProcessor<TData, TResult>, options: import("bullmq").WorkerOptions) {
  const { Worker } = await import("bullmq");
  return new Worker<TData, TResult>(queueName, processor, options);
}
