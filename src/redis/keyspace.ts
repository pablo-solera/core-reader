export function createKeyspace(namespace: string) {
  const root = namespace.replace(/:+$/g, "");
  return (...parts: Array<string | number>) => [root, ...parts].map(part => String(part).replace(/^:+|:+$/g, "")).filter(Boolean).join(":");
}
