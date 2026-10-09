export type ObjectPage = { keys: string[]; nextToken?: string };

export interface ObjectStorage {
  headBucket(): Promise<void>;
  putObject(key: string, body: string | Uint8Array, contentType: string): Promise<void>;
  getObject(key: string): Promise<string | undefined>;
  signGet(key: string, expiresInSeconds: number): Promise<string>;
  list(prefix: string, continuationToken?: string): Promise<ObjectPage>;
  deleteObject(key: string): Promise<void>;
}

export interface BucketProvisioner {
  ensureBucket(): Promise<void>;
  createBucket(): Promise<void>;
}
