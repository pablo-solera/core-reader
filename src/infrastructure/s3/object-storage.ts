import type { BucketProvisioner, ObjectStorage, ObjectPage } from "../../application/ports/object-storage.js";
import { ObjectNotFoundError } from "../../domain/artifact-errors.js";

export type S3ObjectPage = ObjectPage;
export type S3Adapter = ObjectStorage & Partial<Pick<BucketProvisioner, "createBucket">>;
export type S3StoreOptions = { adapter: S3Adapter; autoCreateBucket?: boolean; expiresInSeconds?: number };

export class S3Store implements ObjectStorage, BucketProvisioner {
  constructor(private readonly options: S3StoreOptions) {}

  async ensureBucket() {
    try { await this.options.adapter.headBucket(); }
    catch (error) {
      const status = error && typeof error === "object" && "$metadata" in error
        ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode)
        : 0;
      if (!this.options.autoCreateBucket || status !== 404) throw error;
      if (!this.options.adapter.createBucket) throw error;
      await this.options.adapter.createBucket();
    }
  }

  headBucket() { return this.options.adapter.headBucket(); }
  createBucket() { return this.options.adapter.createBucket?.() ?? Promise.reject(new Error("Bucket provisioning is not configured")); }
  putObject(key: string, body: string | Uint8Array, contentType: string) { return this.options.adapter.putObject(key, body, contentType); }
  getObject(key: string) { return this.options.adapter.getObject(key); }
  signGet(key: string, expiresInSeconds: number) { return this.options.adapter.signGet(key, expiresInSeconds); }
  list(prefix: string, continuationToken?: string) { return this.options.adapter.list(prefix, continuationToken); }
  deleteObject(key: string) { return this.options.adapter.deleteObject(key); }
  putJson(key: string, value: unknown, pretty = true) {
    const body = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
    return this.options.adapter.putObject(key, body, "application/json; charset=utf-8");
  }
  async getJson<T>(key: string): Promise<T> {
    const body = await this.options.adapter.getObject(key);
    if (body === undefined) throw new ObjectNotFoundError(key);
    return JSON.parse(body) as T;
  }
  signedDownload(key: string) { return this.options.adapter.signGet(key, this.options.expiresInSeconds ?? 900); }
  async deletePrefix(prefix: string, validate: (prefix: string) => boolean, batchSize = 25) {
    if (!validate(prefix)) throw new Error("Refusing to delete an invalid object prefix");
    let continuationToken: string | undefined;
    let deleted = 0;
    do {
      const page = await this.options.adapter.list(prefix, continuationToken);
      const deleteBatchSize = this.options.adapter.deleteObjects ? 1000 : batchSize;
      for (let index = 0; index < page.keys.length; index += deleteBatchSize) {
        const batch = page.keys.slice(index, index + deleteBatchSize);
        if (this.options.adapter.deleteObjects) await this.options.adapter.deleteObjects(batch);
        else await Promise.all(batch.map(key => this.options.adapter.deleteObject(key)));
        deleted += batch.length;
      }
      continuationToken = page.nextToken;
    } while (continuationToken);
    return deleted;
  }
}
