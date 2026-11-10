const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Swagger UI page that renders the reader's /openapi.json. */
export function swaggerDocsHtml(title: string, specUrl = "/openapi.json"): string {
  return `<!doctype html><html><head><title>${escapeHtml(title)}</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:${JSON.stringify(specUrl)},dom_id:"#swagger-ui"})</script></body></html>`;
}
