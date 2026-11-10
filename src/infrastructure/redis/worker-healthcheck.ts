import { workerKeys } from "./worker-lock.js";

type HealthClient = { connect(): Promise<unknown>; pttl(key: string): Promise<number>; disconnect(): void; on(event: "error", listener: () => void): unknown };

export type WorkerHealthcheckOptions = {
  namespace: string;
  redisUrl?: string;
  createClient?: (url: string) => HealthClient | Promise<HealthClient>;
};

async function defaultClient(url: string): Promise<HealthClient> {
  const { Redis } = await import("ioredis");
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 3000 }) as unknown as HealthClient;
}

/** Resolves true when the worker heartbeat key exists and has not expired. Never throws. */
export async function checkWorkerHealth(options: WorkerHealthcheckOptions): Promise<boolean> {
  let client: HealthClient | undefined;
  try {
    client = await (options.createClient ?? defaultClient)(options.redisUrl ?? "redis://127.0.0.1:6379");
    client.on("error", () => undefined);
    await client.connect();
    return (await client.pttl(workerKeys(options.namespace).heartbeatKey)) > 0;
  } catch {
    return false;
  } finally {
    client?.disconnect();
  }
}

/** Entry point for container healthchecks: sets process.exitCode to 0 (healthy) or 1. */
export async function runWorkerHealthcheck(options: WorkerHealthcheckOptions): Promise<void> {
  process.exitCode = (await checkWorkerHealth(options)) ? 0 : 1;
}
