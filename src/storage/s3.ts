export type S3ObjectPage = { keys: string[]; nextToken?: string };
export type S3Adapter = {
  headBucket(): Promise<void>;
  createBucket(): Promise<void>;
  putObject(key: string, body: string | Uint8Array, contentType: string): Promise<void>;
  getObject(key: string): Promise<string | undefined>;
  signGet(key: string, expiresInSeconds: number): Promise<string>;
  list(prefix: string, continuationToken?: string): Promise<S3ObjectPage>;
  deleteObject(key: string): Promise<void>;
};
export type S3StoreOptions = { adapter: S3Adapter; autoCreateBucket?: boolean; expiresInSeconds?: number };

/** Provider-independent orchestration shared by readers; SDK details live in each adapter. */
export class S3Store {
  constructor(private readonly options: S3StoreOptions) {}

  async ensureBucket() {
    try { await this.options.adapter.headBucket(); }
    catch (error) {
      const status = error && typeof error === "object" && "$metadata" in error
        ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode)
        : 0;
      if (!this.options.autoCreateBucket || status !== 404) throw error;
      await this.options.adapter.createBucket();
    }
  }

  headBucket() { return this.options.adapter.headBucket(); }
  putJson(key: string, value: unknown, pretty = true) {
    const body = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
    return this.options.adapter.putObject(key, body, "application/json; charset=utf-8");
  }
  async getJson<T>(key: string): Promise<T> {
    const body = await this.options.adapter.getObject(key);
    if (body === undefined) throw Object.assign(new Error(`S3 object not found: ${key}`), { statusCode: 404 });
    return JSON.parse(body) as T;
  }
  signedDownload(key: string) { return this.options.adapter.signGet(key, this.options.expiresInSeconds ?? 900); }
  async deletePrefix(prefix: string, validate: (prefix: string) => boolean, batchSize = 25) {
    if (!validate(prefix)) throw new Error("Refusing to delete an invalid object prefix");
    let continuationToken: string | undefined;
    let deleted = 0;
    do {
      const page = await this.options.adapter.list(prefix, continuationToken);
      for (let index = 0; index < page.keys.length; index += batchSize) {
        const batch = page.keys.slice(index, index + batchSize);
        await Promise.all(batch.map(key => this.options.adapter.deleteObject(key)));
        deleted += batch.length;
      }
      continuationToken = page.nextToken;
    } while (continuationToken);
    return deleted;
  }
}
