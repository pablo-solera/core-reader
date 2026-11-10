import { describe, expect, test } from "bun:test";
import { swaggerDocsHtml } from "../src/interfaces/http/express/docs.js";
import { createJsonLogger } from "../src/shared/logger.js";

describe("swaggerDocsHtml", () => {
  test("points Swagger UI at the spec and escapes the title", () => {
    const html = swaggerDocsHtml('Mercedes <Reader> & "API"');
    expect(html).toContain("<title>Mercedes &lt;Reader&gt; &amp; &quot;API&quot;</title>");
    expect(html).toContain('url:"/openapi.json"');
    expect(swaggerDocsHtml("x", "/spec.json")).toContain('url:"/spec.json"');
  });
});

describe("createJsonLogger", () => {
  test("writes one JSON line per event to the matching level", () => {
    const lines: string[] = [];
    const sink = { info: (v: string) => lines.push(`i:${v}`), warn: (v: string) => lines.push(`w:${v}`), error: (v: string) => lines.push(`e:${v}`) };
    const logger = createJsonLogger(sink as never);
    logger.info("started", { port: 1 });
    logger.warn("slow");
    logger.error("boom", { code: "X" });
    expect(lines).toEqual(['i:{"event":"started","port":1}', 'w:{"event":"slow"}', 'e:{"event":"boom","code":"X"}']);
  });
});
