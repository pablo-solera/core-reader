export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<R>, shouldContinue: () => boolean = () => true): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  const worker = async () => {
    while (firstError === undefined && shouldContinue()) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try { results[index] = await run(items[index]!, index); }
      catch (error) { firstError = error; return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (firstError !== undefined) throw firstError;
  return results;
}
