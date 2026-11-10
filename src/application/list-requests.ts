import { parseRequestCursor, requestNextCursor, type RequestCursorPosition } from "../domain/cursor.js";

export type ListRequestsDependencies<TState extends { requestId: string; createdAt: string }, TItem> = {
  ensureIndex(): Promise<void>;
  cutoff(): number;
  pruneExpired(cutoff: number): Promise<void>;
  fetchRequestIds(cutoff: number, after: RequestCursorPosition | null, count: number): Promise<string[]>;
  fetchStates(requestIds: string[]): Promise<Array<TState | null>>;
  removeMissing(requestIds: string[]): Promise<void>;
  /** Returns the items a state contributes after applying the caller's filters (empty when filtered out). */
  summarize(state: TState): TItem[];
};

/** Keyset pagination over the request index: filters are applied after loading, so pages always hold `count` matches when available. */
export async function listRequestsPage<TState extends { requestId: string; createdAt: string }, TItem>(
  cursor: string | undefined,
  count: number,
  dependencies: ListRequestsDependencies<TState, TItem>,
): Promise<{ items: TItem[]; nextCursor: string | null }> {
  await dependencies.ensureIndex();
  let after = parseRequestCursor(cursor);
  const cutoff = dependencies.cutoff();
  await dependencies.pruneExpired(cutoff);
  const items: TItem[] = [];
  let hasMore = false;
  let lastScanned = after;
  let continuation: RequestCursorPosition | null = null;
  let exhausted = false;
  while (items.length <= count && !exhausted) {
    const batchSize = Math.max(50, count + 1);
    const requestIds = await dependencies.fetchRequestIds(cutoff, after, batchSize);
    if (requestIds.length < batchSize) exhausted = true;
    if (!requestIds.length) break;
    const states = await dependencies.fetchStates(requestIds);
    const missing = requestIds.filter((_id, index) => states[index] === null);
    if (missing.length) await dependencies.removeMissing(missing);
    for (let index = 0; index < requestIds.length; index++) {
      const state = states[index];
      if (state) {
        const matching = dependencies.summarize(state);
        if (matching.length && items.length === count) {
          hasMore = true;
          continuation = lastScanned;
          break;
        }
        items.push(...matching);
        const score = Date.parse(state.createdAt);
        if (Number.isFinite(score)) lastScanned = { score, requestId: requestIds[index]! };
      }
    }
    if (hasMore) break;
    after = lastScanned;
  }
  const next = continuation ?? (hasMore ? after : null);
  return { items, nextCursor: next ? requestNextCursor(next) : null };
}
