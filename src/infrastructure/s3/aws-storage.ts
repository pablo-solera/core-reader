import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createHash } from "node:crypto";
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  type ServiceInputTypes,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { HttpRequest } from "@smithy/core/protocols";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Logger } from "../../application/ports/runtime.js";
import { S3Store } from "./object-storage.js";

export type AwsStorageSettings = {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Prefix prepended to every key built with `objectKey`. */
  prefix?: string;
  autoCreateBucket?: boolean;
  requestTimeoutMs?: number;
  signedUrlExpiresInSeconds?: number;
  /** Maximum number of objects `listObjects` may return before failing. */
  maxListedObjects?: number;
  /** Guards `deletePrefix`: a prefix is only deleted when this returns true. */
  isDeletablePrefix?: (prefix: string) => boolean;
  logger?: Pick<Logger, "info">;
};

const trimSlashes = (value: string) => value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

export function createAwsObjectStorage(settings: AwsStorageSettings, requestHandler?: S3ClientConfig["requestHandler"]) {
  const requestTimeoutMs = settings.requestTimeoutMs ?? 30_000;
  const maxListed = settings.maxListedObjects ?? 10_000;
  const client = new S3Client({
    region: settings.region ?? "us-east-1",
    endpoint: settings.endpoint,
    forcePathStyle: settings.forcePathStyle,
    credentials: settings.accessKeyId && settings.secretAccessKey ? { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey } : undefined,
    maxAttempts: 5,
    retryMode: "adaptive",
    requestHandler: requestHandler ?? new FetchHttpHandler({ requestTimeout: requestTimeoutMs }),
  });
  // S3-compatible stores such as RustFS require Content-MD5 on DeleteObjects.
  client.middlewareStack.add((next) => async args => {
    const request = args.request;
    if (HttpRequest.isInstance(request) && request.method === "POST" && "delete" in request.query) {
      const body = request.body;
      const bytes = typeof body === "string" ? Buffer.from(body) : body instanceof Uint8Array ? Buffer.from(body) : undefined;
      if (bytes) request.headers["content-md5"] = createHash("md5").update(bytes).digest("base64");
    }
    return next(args);
  }, { name: "contentMd5ForDeleteObjects", step: "build", priority: "low", override: true });

  async function withS3Timeout<T>(operation: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`S3 ${operation} timed out after ${requestTimeoutMs}ms`)), requestTimeoutMs);
    const startedAt = Date.now();
    try { return await run(controller.signal); }
    finally {
      clearTimeout(timeout);
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 5000) settings.logger?.info("s3_operation_slow", { operation, elapsedMs });
    }
  }

  async function sendS3<O>(command: { readonly input: ServiceInputTypes }, operation: string): Promise<O> {
    return withS3Timeout(operation, signal => client.send(command as never, { abortSignal: signal }) as Promise<O>);
  }

  async function listObjects(prefix: string) {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await sendS3<{ Contents?: Array<{ Key?: string }>; NextContinuationToken?: string }>(
        new ListObjectsV2Command({ Bucket: settings.bucket, Prefix: prefix, ContinuationToken: continuationToken, MaxKeys: 1000 }),
        "list-archive-objects",
      );
      keys.push(...(page.Contents ?? []).flatMap(item => item.Key ? [item.Key] : []));
      continuationToken = page.NextContinuationToken;
      if (keys.length > maxListed) throw new Error("Archive contains too many files");
    } while (continuationToken);
    return keys;
  }

  async function getObjectStream(key: string) {
    const result = await sendS3<{ Body?: unknown }>(new GetObjectCommand({ Bucket: settings.bucket, Key: key }), "get-archive-object");
    const body = result.Body as { pipe?: unknown; getReader?: unknown } | undefined;
    if (body && typeof body.pipe === "function") return body as NodeJS.ReadableStream;
    if (body && typeof body.getReader === "function") return Readable.fromWeb(body as NodeReadableStream);
    throw new Error(`S3 object ${key} has no readable body`);
  }

  const store = new S3Store({
    adapter: {
      async headBucket() { await sendS3(new HeadBucketCommand({ Bucket: settings.bucket }), "head-bucket"); },
      async createBucket() { await sendS3(new CreateBucketCommand({ Bucket: settings.bucket }), "create-bucket"); },
      async putObject(key, body, contentType) { await sendS3(new PutObjectCommand({ Bucket: settings.bucket, Key: key, Body: body, ContentType: contentType }), "put-json"); },
      async getObject(key) {
        return withS3Timeout("get-json", async signal => {
          const result = await client.send(new GetObjectCommand({ Bucket: settings.bucket, Key: key }), { abortSignal: signal });
          return result.Body ? result.Body.transformToString("utf-8") : undefined;
        });
      },
      signGet(key, expiresInSeconds) { return getSignedUrl(client, new GetObjectCommand({ Bucket: settings.bucket, Key: key }), { expiresIn: expiresInSeconds }); },
      async list(prefix, continuationToken) {
        const page = await sendS3<{ Contents?: Array<{ Key?: string }>; NextContinuationToken?: string }>(new ListObjectsV2Command({ Bucket: settings.bucket, Prefix: prefix, ContinuationToken: continuationToken }), "list-delete-prefix");
        return { keys: (page.Contents ?? []).flatMap(item => item.Key ? [item.Key] : []), nextToken: page.NextContinuationToken };
      },
      async deleteObject(key) { await sendS3(new DeleteObjectCommand({ Bucket: settings.bucket, Key: key }), "delete-object"); },
      async deleteObjects(keys) {
        if (!keys.length) return;
        const result = await sendS3<{ Errors?: Array<{ Key?: string; Code?: string; Message?: string }> }>(
          new DeleteObjectsCommand({ Bucket: settings.bucket, Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true } }),
          "delete-objects",
        );
        if (result.Errors?.length) throw new Error(`S3 failed to delete ${result.Errors.length} object(s): ${result.Errors.slice(0, 5).map(item => `${item.Key ?? "unknown"} (${item.Code ?? item.Message ?? "unknown error"})`).join(", ")}`);
      },
    },
    autoCreateBucket: settings.autoCreateBucket,
    expiresInSeconds: settings.signedUrlExpiresInSeconds ?? 900,
  });

  return {
    bucket: settings.bucket,
    objectKey: (...parts: string[]) => [settings.prefix ?? "", ...parts].map(trimSlashes).filter(Boolean).join("/"),
    async ensureBucket() {
      try { await store.ensureBucket(); }
      catch { throw new Error(`Cannot access S3 bucket ${settings.bucket}; autoCreateBucket only permits creation after a 404`); }
    },
    checkBucket: () => store.headBucket(),
    signedDownload: (key: string) => store.signedDownload(key),
    listObjects,
    getObjectStream,
    putJson: (key: string, value: unknown) => store.putJson(key, value, true),
    putJsonCompact: (key: string, value: unknown) => store.putJson(key, value, false),
    deletePrefix: (prefix: string) => store.deletePrefix(prefix, settings.isDeletablePrefix ?? (() => false)),
    getJson: <T>(key: string) => store.getJson<T>(key),
    async getJsonIfExists<T>(key: string): Promise<T | undefined> {
      try { return await store.getJson<T>(key); }
      catch (error) {
        const value = error as { name?: string; statusCode?: number; $metadata?: { httpStatusCode?: number } };
        if (value.name === "NoSuchKey" || value.name === "NotFound" || value.statusCode === 404 || value.$metadata?.httpStatusCode === 404) return undefined;
        throw error;
      }
    },
  };
}

export type AwsObjectStorage = ReturnType<typeof createAwsObjectStorage>;
