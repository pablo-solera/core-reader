/** OAuth2 client-credentials token pool: several tokens rotated round-robin, deduplicated refreshes and spaced token requests. */

export type AccessToken = { value: string; expiresAt: number };
export type TokenResponse = { access_token: string; expires_in?: string | number };

export function nextTokenIndex(current: number, poolSize: number): number {
  if (poolSize < 1) throw new Error("Token pool must have at least one slot");
  return (current + 1) % poolSize;
}

/** Expires one minute early so a token is never used right at its limit. */
export function tokenExpiresAt(now: number, expiresIn: string | number | undefined): number {
  const ttlSeconds = Math.max(60, Number(expiresIn) || 3600);
  return now + Math.max(1, ttlSeconds - 60) * 1000;
}

/** `status` is set when the token endpoint answered; it is missing for network failures, which are always transient. */
export class TokenError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "TokenError"; }
  get transient() { return this.status === undefined || this.status === 429 || this.status >= 500; }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class AccessTokenPool {
  private readonly slots: Array<AccessToken | undefined>;
  private readonly pending = new Map<number, { promise: Promise<string>; token?: string }>();
  private index = 0;
  private authNextAt = 0;
  private authQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly size: number,
    private readonly request: () => Promise<TokenResponse>,
    private readonly minAuthSpacingMs = 250,
  ) {
    if (!Number.isInteger(size) || size < 1) throw new Error("Token pool size must be a positive integer");
    this.slots = new Array(size);
  }

  async get(): Promise<string> {
    const slot = this.index;
    this.index = nextTokenIndex(this.index, this.size);
    const cached = this.slots[slot];
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const inFlight = this.pending.get(slot);
    if (inFlight) return inFlight.promise;
    return this.refresh(slot, cached?.value);
  }

  /** Replaces the slot holding the rejected token (for example after a 401). */
  async renew(rejectedToken?: string): Promise<string> {
    let slot = rejectedToken ? this.slots.findIndex(token => token?.value === rejectedToken) : this.index;
    if (slot < 0) slot = this.index;
    return this.refresh(slot, rejectedToken, true);
  }

  private async refresh(slot: number, rejectedToken?: string, force = false): Promise<string> {
    const cached = this.slots[slot];
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
    const inFlight = this.pending.get(slot);
    if (inFlight && (!force || !rejectedToken || inFlight.token !== rejectedToken)) return inFlight.promise;

    const previousToken = cached?.value;
    const promise = this.enqueueAuthRequest().then(token => {
      if (force && rejectedToken && previousToken !== rejectedToken) {
        const otherSlot = this.slots.findIndex((candidate, candidateIndex) => candidateIndex !== slot && candidate?.value === rejectedToken);
        if (otherSlot >= 0) this.slots[otherSlot] = { value: token.access_token, expiresAt: tokenExpiresAt(Date.now(), token.expires_in) };
        return this.slots[otherSlot]?.value ?? token.access_token;
      }
      const value: AccessToken = { value: token.access_token, expiresAt: tokenExpiresAt(Date.now(), token.expires_in) };
      this.slots[slot] = value;
      return value.value;
    }).finally(() => {
      if (this.pending.get(slot)?.promise === promise) this.pending.delete(slot);
    });
    this.pending.set(slot, { promise, token: rejectedToken });
    return promise;
  }

  private enqueueAuthRequest(): Promise<TokenResponse> {
    const request = this.authQueue.then(async () => {
      const waitMs = Math.max(0, this.authNextAt - Date.now());
      if (waitMs) await sleep(waitMs);
      this.authNextAt = Date.now() + this.minAuthSpacingMs;
      return this.request();
    });
    this.authQueue = request.then(() => undefined, () => undefined);
    return request;
  }
}

export type ClientCredentialsOptions = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** "body" sends client_id/client_secret in the form (BMW); "basic" sends an Authorization: Basic header (Mercedes-Benz). */
  authStyle?: "body" | "basic";
  timeoutMs?: number;
  /** Prefix for error messages, for example "BMW" or "Mercedes". */
  label?: string;
  fetch?: typeof fetch;
};

export function createClientCredentialsRequest(options: ClientCredentialsOptions) {
  const label = options.label ?? "OAuth";
  return async function requestToken(): Promise<TokenResponse> {
    if (!options.clientId || !options.clientSecret) throw new Error(`${label} client credentials are not configured`);
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (options.scope) form.set("scope", options.scope);
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (options.authStyle === "basic") headers.Authorization = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`;
    else { form.set("client_id", options.clientId); form.set("client_secret", options.clientSecret); }
    const response = await (options.fetch ?? fetch)(options.tokenUrl, {
      method: "POST",
      headers,
      body: form,
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    }).catch(error => { throw new TokenError(`${label} token request failed: ${error instanceof Error ? error.message : String(error)}`); });
    const body = await response.json().catch(() => ({})) as Partial<TokenResponse> & { error_description?: string };
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) throw new TokenError(`${label} token endpoint returned HTTP ${response.status}: ${body.error_description ?? "invalid token response"}`, response.status);
    return body as TokenResponse;
  };
}

export function createAccessTokenProvider(pool: AccessTokenPool) {
  return { getAccessToken: () => pool.get(), renewAccessToken: (rejectedToken?: string) => pool.renew(rejectedToken) };
}

export type AccessTokenProvider = ReturnType<typeof createAccessTokenProvider>;
