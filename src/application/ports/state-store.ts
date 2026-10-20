export interface StateStore<T extends { updatedAt: string }> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T, updatedAt?: string): Promise<T>;
  patch(id: string, patch: Partial<T>, deletedKeys?: string[], ifMatches?: Partial<T>): Promise<T | null>;
}
