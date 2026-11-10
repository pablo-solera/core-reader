import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, test } from "bun:test";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { HttpRequest, HttpResponse } from "@smithy/core/protocols";
import { createAwsObjectStorage } from "../src/infrastructure/s3/aws-storage.js";

const settings = { bucket: "test-bucket", endpoint: "http://127.0.0.1:9000", forcePathStyle: true, accessKeyId: "test-access", secretAccessKey: "test-secret" };

const handlerReturning = (respond: (request: HttpRequest) => unknown) => ({
  async handle(request: HttpRequest) { return { response: new HttpResponse(respond(request) as never) }; },
  destroy() {},
}) as unknown as S3ClientConfig["requestHandler"];

const xml = (body: string) => ({ statusCode: 200, headers: { "content-type": "application/xml" }, body: Readable.from([body]) });

describe("AWS object storage", () => {
  test("builds keys under the configured prefix", () => {
    const storage = createAwsObjectStorage({ ...settings, prefix: "/root/" });
    expect(storage.objectKey("a\\b", "/c/", "")).toBe("root/a/b/c");
    expect(createAwsObjectStorage(settings).objectKey("a", "b")).toBe("a/b");
  });

  test("adds Content-MD5 matching the exact DeleteObjects body", async () => {
    const prefix = "MERCEDES/x/labour/s/20261021/223159";
    const objectKey = `${prefix}/object.json`;
    let requestBody: string | Uint8Array | undefined;
    let contentMd5: string | undefined;
    const storage = createAwsObjectStorage({ ...settings, isDeletablePrefix: value => value === prefix }, handlerReturning(request => {
      if (Object.hasOwn(request.query, "delete")) {
        requestBody = request.body as string | Uint8Array;
        contentMd5 = request.headers["content-md5"];
        return xml(`<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Deleted><Key>${objectKey}</Key></Deleted></DeleteResult>`);
      }
      return xml(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><Prefix>${prefix}</Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>${objectKey}</Key><LastModified>2026-10-21T00:00:00.000Z</LastModified><ETag>etag</ETag><Size>1</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>`);
    }));
    expect(await storage.deletePrefix(prefix)).toBe(1);
    const bytes = typeof requestBody === "string" ? Buffer.from(requestBody) : Buffer.from(requestBody ?? []);
    expect(contentMd5).toBe(createHash("md5").update(bytes).digest("base64"));
  });

  test("refuses to delete a prefix that is not explicitly deletable", async () => {
    const storage = createAwsObjectStorage(settings, handlerReturning(() => xml("<x/>")));
    await expect(storage.deletePrefix("anything")).rejects.toThrow();
  });

  test("getJsonIfExists maps a missing key to undefined and rethrows other failures", async () => {
    const missing = createAwsObjectStorage(settings, handlerReturning(() => ({ statusCode: 404, headers: { "content-type": "application/xml" }, body: Readable.from(['<Error><Code>NoSuchKey</Code><Message>no</Message></Error>']) })));
    expect(await missing.getJsonIfExists("a.json")).toBeUndefined();
    const broken = createAwsObjectStorage({ ...settings }, handlerReturning(() => ({ statusCode: 403, headers: { "content-type": "application/xml" }, body: Readable.from(['<Error><Code>AccessDenied</Code><Message>no</Message></Error>']) })));
    await expect(broken.getJsonIfExists("a.json")).rejects.toThrow();
  });
});

describe("getObjectStream", () => {
  const storageWithBody = (body: unknown) => createAwsObjectStorage(settings, handlerReturning(() => ({ statusCode: 200, headers: { "content-type": "application/json" }, body })));
  async function read(stream: NodeJS.ReadableStream) {
    let text = "";
    for await (const chunk of stream) text += Buffer.from(chunk as Buffer).toString();
    return text;
  }

  test("reads Node stream bodies", async () => {
    expect(await read(await storageWithBody(Readable.from(["hello"])).getObjectStream("a/b.json"))).toBe("hello");
  });

  test("converts web stream bodies, which Bun returns, into Node streams", async () => {
    const web = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("web")); controller.close(); } });
    expect(await read(await storageWithBody(web).getObjectStream("a/b.json"))).toBe("web");
  });
});
