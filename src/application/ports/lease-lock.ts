export interface LeaseLock {
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<boolean>;
}
