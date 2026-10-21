import { applyApiKey } from './credentials.js';
import {
  DAS_MAX_BATCH,
  Pages,
  withOptions,
  type Asset,
  type AssetList,
  type AssetProof,
  type AssetSignatures,
  type AssetWithProof,
  type DisplayOptions,
  type GetAssetsByAuthorityRequest,
  type GetAssetsByCreatorRequest,
  type GetAssetsByGroupRequest,
  type GetAssetsByOwnerRequest,
  type GetNftEditionsRequest,
  type GetSignaturesForAssetRequest,
  type GetTokenAccountsRequest,
  type NftEditions,
  type PagedMethod,
  type PagedMethods,
  type SearchAssetsRequest,
  type TokenAccountList,
} from './das.js';
import { EndpointSet } from './endpoint.js';
import { OrbitflareError, sanitizeUrl } from './error.js';
import { type Logger, type LogLevel, resolveLogger } from './logger.js';
import { defaultRetryPolicy, delayForAttempt, hasAttemptsLeft, type RetryPolicy } from './retry.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RangeFilter<T> {
  gte?: T;
  gt?: T;
  lte?: T;
  lt?: T;
  eq?: T;
}

export interface GetTransactionsFilters {
  tokenAccounts?: string;
  blockTime?: RangeFilter<number>;
  slot?: RangeFilter<number>;
  signature?: RangeFilter<string>;
  status?: string;
}

export interface GetTransactionsOptions {
  transactionDetails?: string;
  limit?: number;
  sortOrder?: string;
  paginationToken?: string;
  commitment?: string;
  encoding?: string;
  maxSupportedTransactionVersion?: number;
  minContextSlot?: number;
  filters?: GetTransactionsFilters;
}

export interface GetTransactionsResult {
  data: unknown[];
  paginationToken?: string;
}

export class RpcClient {
  private readonly endpoints: EndpointSet;
  private readonly apiKey: string | undefined;
  private readonly _commitment: string;
  private readonly retry: RetryPolicy;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(opts: {
    endpoints: EndpointSet;
    apiKey: string | undefined;
    commitment: string;
    retry: RetryPolicy;
    timeoutMs: number;
    logger: Logger;
  }) {
    this.endpoints = opts.endpoints;
    this.apiKey = opts.apiKey;
    this._commitment = opts.commitment;
    this.retry = opts.retry;
    this.timeoutMs = opts.timeoutMs;
    this.logger = opts.logger;
  }

  commitment(): string {
    return this._commitment;
  }

  async request<T = any>(method: string, params: any): Promise<T> {
    const body = { jsonrpc: '2.0', id: 1, method, params };
    return this.execute<T>(body, method);
  }

  async requestRaw<T = any>(body: string): Promise<T> {
    const parsed = JSON.parse(body);
    const method = typeof parsed?.method === 'string' ? parsed.method : 'raw';
    return this.execute<T>(parsed, method);
  }

  async getSlot(): Promise<number> {
    const r = await this.request('getSlot', [{ commitment: this._commitment }]);
    if (typeof r !== 'number') throw OrbitflareError.serialization('expected number for slot');
    return r;
  }

  async getBalance(address: string): Promise<number> {
    const r = await this.request<any>('getBalance', [address, { commitment: this._commitment }]);
    if (typeof r?.value !== 'number') throw OrbitflareError.serialization('expected balance value');
    return r.value;
  }

  async getAccountInfo(address: string): Promise<any | null> {
    const r = await this.request<any>('getAccountInfo', [
      address,
      { encoding: 'base64', commitment: this._commitment },
    ]);
    return r?.value ?? null;
  }

  async getMultipleAccounts(addresses: string[]): Promise<(any | null)[]> {
    const all: (any | null)[] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const r = await this.request<any>('getMultipleAccounts', [
        chunk,
        { encoding: 'base64', commitment: this._commitment },
      ]);
      const arr = r?.value;
      if (Array.isArray(arr)) {
        for (const item of arr) all.push(item ?? null);
      }
    }
    return all;
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const r = await this.request<any>('getLatestBlockhash', [{ commitment: this._commitment }]);
    const v = r?.value;
    if (typeof v?.blockhash !== 'string') throw OrbitflareError.serialization('missing blockhash');
    if (typeof v?.lastValidBlockHeight !== 'number')
      throw OrbitflareError.serialization('missing lastValidBlockHeight');
    return { blockhash: v.blockhash, lastValidBlockHeight: v.lastValidBlockHeight };
  }

  async getTransaction(signature: string): Promise<any> {
    return this.request('getTransaction', [
      signature,
      {
        encoding: 'json',
        commitment: this._commitment,
        maxSupportedTransactionVersion: 1,
      },
    ]);
  }

  async getSignaturesForAddress(address: string, limit: number): Promise<any[]> {
    const r = await this.request<any[]>('getSignaturesForAddress', [
      address,
      { limit, commitment: this._commitment },
    ]);
    if (!Array.isArray(r)) throw OrbitflareError.serialization('expected array');
    return r;
  }

  async getProgramAccounts(programId: string): Promise<any[]> {
    const r = await this.request<any[]>('getProgramAccounts', [
      programId,
      { encoding: 'base64', commitment: this._commitment },
    ]);
    if (!Array.isArray(r)) throw OrbitflareError.serialization('expected array');
    return r;
  }

  async getRecentPrioritizationFees(addresses: string[]): Promise<any[]> {
    const r = await this.request<any[]>('getRecentPrioritizationFees', [addresses]);
    if (!Array.isArray(r)) throw OrbitflareError.serialization('expected array');
    return r;
  }

  async sendTransaction(txBase64: string): Promise<string> {
    const r = await this.request<any>('sendTransaction', [
      txBase64,
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: this._commitment,
      },
    ]);
    if (typeof r !== 'string') throw OrbitflareError.serialization('expected signature string');
    return r;
  }

  async simulateTransaction(txBase64: string): Promise<any> {
    return this.request('simulateTransaction', [
      txBase64,
      { encoding: 'base64', commitment: this._commitment },
    ]);
  }

  async getTokenAccountsByOwner(owner: string, mint?: string, programId?: string): Promise<any[]> {
    const filter = mint
      ? { mint }
      : programId
        ? { programId }
        : { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
    const r = await this.request<any>('getTokenAccountsByOwner', [
      owner,
      filter,
      { encoding: 'jsonParsed', commitment: this._commitment },
    ]);
    if (!Array.isArray(r?.value)) throw OrbitflareError.serialization('expected array');
    return r.value;
  }

  async getTransactionsForAddress(
    address: string,
    options: GetTransactionsOptions = {},
  ): Promise<GetTransactionsResult> {
    const result = await this.request<any>('getTransactionsForAddress', [address, options]);
    return {
      data: Array.isArray(result?.data) ? result.data : [],
      paginationToken:
        typeof result?.paginationToken === 'string' ? result.paginationToken : undefined,
    };
  }

  private resolveApiKey(): string | undefined {
    return this.apiKey ?? process.env.ORBITFLARE_LICENSE_KEY ?? undefined;
  }

  // ---------- DAS API ----------

  async getAsset(id: string, options?: DisplayOptions): Promise<Asset> {
    return this.request<Asset>('getAsset', withOptions({ id }, options));
  }

  /** One entry per ID, in order, with `null` for IDs that are not indexed assets. */
  async getAssetBatch(ids: string[], options?: DisplayOptions): Promise<(Asset | null)[]> {
    const out: (Asset | null)[] = [];
    for (let i = 0; i < ids.length; i += DAS_MAX_BATCH) {
      const chunk = ids.slice(i, i + DAS_MAX_BATCH);
      const assets = await this.request<(Asset | null)[]>(
        'getAssetBatch',
        withOptions({ ids: chunk }, options),
      );
      out.push(...assets);
    }
    return out;
  }

  async getAssetProof(id: string): Promise<AssetProof> {
    return this.request<AssetProof>('getAssetProof', { id });
  }

  /** Proofs keyed by asset ID, with `null` where no proof was found. */
  async getAssetProofBatch(ids: string[]): Promise<Record<string, AssetProof | null>> {
    const out: Record<string, AssetProof | null> = {};
    for (let i = 0; i < ids.length; i += DAS_MAX_BATCH) {
      const chunk = ids.slice(i, i + DAS_MAX_BATCH);
      Object.assign(out, await this.request('getAssetProofBatch', { ids: chunk }));
    }
    return out;
  }

  /**
   * A compressed asset and its Merkle proof in one call: everything a Bubblegum transfer, burn
   * or delegate instruction needs.
   */
  async getAssetWithProof(id: string, options?: DisplayOptions): Promise<AssetWithProof> {
    return this.request<AssetWithProof>('getAssetWithProof', withOptions({ id }, options));
  }

  async getAssetsByOwner(req: GetAssetsByOwnerRequest): Promise<AssetList> {
    return this.request<AssetList>('getAssetsByOwner', withOptions(req, req.options));
  }

  async getAssetsByGroup(req: GetAssetsByGroupRequest): Promise<AssetList> {
    return this.request<AssetList>('getAssetsByGroup', withOptions(req, req.options));
  }

  async getAssetsByCreator(req: GetAssetsByCreatorRequest): Promise<AssetList> {
    return this.request<AssetList>('getAssetsByCreator', withOptions(req, req.options));
  }

  async getAssetsByAuthority(req: GetAssetsByAuthorityRequest): Promise<AssetList> {
    return this.request<AssetList>('getAssetsByAuthority', withOptions(req, req.options));
  }

  async searchAssets(req: SearchAssetsRequest): Promise<AssetList> {
    return this.request<AssetList>('searchAssets', withOptions(req, req.options));
  }

  async getTokenAccounts(req: GetTokenAccountsRequest): Promise<TokenAccountList> {
    if (!req.owner && !req.mint) {
      throw OrbitflareError.config('getTokenAccounts needs an owner, a mint or both');
    }
    return this.request<TokenAccountList>('getTokenAccounts', withOptions(req, req.options));
  }

  async getNftEditions(req: GetNftEditionsRequest): Promise<NftEditions> {
    return this.request<NftEditions>('getNftEditions', req);
  }

  async getSignaturesForAsset(req: GetSignaturesForAssetRequest): Promise<AssetSignatures> {
    if (!req.id && (!req.tree || req.leafIndex === undefined)) {
      throw OrbitflareError.config('getSignaturesForAsset needs an id, or a tree and leaf index');
    }
    const r = await this.request<any>('getSignaturesForAsset', req);
    return {
      ...r,
      items: (r?.items ?? []).map(([signature, instruction]: [string, string]) => ({
        signature,
        instruction,
      })),
    };
  }

  /**
   * Walks every page of a list request. Requests sorted by `id` page by cursor; other sorts,
   * and requests that set `page`, page by number.
   *
   * ```ts
   * for await (const page of client.pages('getAssetsByGroup', { groupKey: 'collection', groupValue })) {
   *   for (const asset of page.items) console.log(asset.id);
   * }
   * ```
   */
  pages<M extends PagedMethod>(method: M, req: PagedMethods[M]['request']): Pages<M> {
    return new Pages(method, req, (m, r) => (this as any)[m](r));
  }

  private async execute<T>(body: unknown, method: string): Promise<T> {
    let lastErr: OrbitflareError | undefined;
    let tried = 0;

    while (tried < this.endpoints.length) {
      const idx = this.endpoints.pick();
      const url = this.endpoints.get(idx);
      let attempt = 0;
      tried += 1;

      while (true) {
        attempt += 1;
        try {
          const result = await this.post<T>(url, body);
          this.endpoints.markSuccess(idx);
          return result;
        } catch (raw) {
          const err = toOrbitflareError(raw);
          const retryable = err.isRetryable();

          if (retryable && hasAttemptsLeft(this.retry, attempt)) {
            const delayMs = err.retryAfter() ?? delayForAttempt(this.retry, attempt);
            this.logger.warn('retrying', { method, attempt, delayMs, error: err });
            await sleep(delayMs);
            continue;
          }

          this.endpoints.markFailure(idx);
          this.logger.warn('failing over', { method, endpoint: sanitizeUrl(url), error: err });
          lastErr = err.withEndpoint(url);
          break;
        }
      }
    }

    throw lastErr ?? OrbitflareError.transport(new Error('all endpoints exhausted'));
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const key = this.resolveApiKey();
    const authUrl = key ? applyApiKey(url, key) : url;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        throw OrbitflareError.timeout();
      }
      throw OrbitflareError.transport(e);
    } finally {
      clearTimeout(timer);
    }

    const status = resp.status;

    if (status === 429) {
      const header = resp.headers.get('retry-after');
      const secs = header ? Number.parseInt(header, 10) : NaN;
      await resp.text().catch(() => undefined);
      throw OrbitflareError.rateLimited(Number.isFinite(secs) ? secs * 1000 : undefined);
    }

    const text = await resp.text();

    if (status >= 500 && status <= 599) {
      throw OrbitflareError.transport(new Error(`HTTP ${status}: ${text.trim()}`));
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw OrbitflareError.rpc(-status, text.trim());
    }

    if (parsed && typeof parsed === 'object' && parsed.error) {
      const code = typeof parsed.error.code === 'number' ? parsed.error.code : 0;
      const message =
        typeof parsed.error.message === 'string' ? parsed.error.message : 'unknown rpc error';
      throw OrbitflareError.rpc(code, message);
    }

    if (status >= 200 && status < 300) {
      return parsed.result as T;
    }

    throw OrbitflareError.rpc(-status, text.trim());
  }
}

function toOrbitflareError(e: unknown): OrbitflareError {
  if (e instanceof OrbitflareError) return e;
  if (e instanceof Error) return OrbitflareError.transport(e);
  return OrbitflareError.transport(new Error(String(e)));
}

export class RpcClientBuilder {
  private _url?: string;
  private _fallbacks: string[] = [];
  private _apiKey?: string;
  private _commitment = 'confirmed';
  private _retry: RetryPolicy = defaultRetryPolicy();
  private _timeoutMs = 30_000;
  private _logger?: Logger;
  private _logLevel?: LogLevel;

  url(url: string): this {
    this._url = url;
    return this;
  }

  logger(logger: Logger): this {
    this._logger = logger;
    return this;
  }

  logLevel(level: LogLevel): this {
    this._logLevel = level;
    return this;
  }

  urls(urls: string[]): this {
    if (urls.length > 0) {
      this._url = urls[0];
      this._fallbacks = urls.slice(1);
    }
    return this;
  }

  fallbackUrl(url: string): this {
    this._fallbacks.push(url);
    return this;
  }

  fallbackUrls(urls: string[]): this {
    this._fallbacks.push(...urls);
    return this;
  }

  apiKey(key: string): this {
    this._apiKey = key;
    return this;
  }

  commitment(commitment: string): this {
    this._commitment = commitment;
    return this;
  }

  retry(policy: RetryPolicy): this {
    this._retry = policy;
    return this;
  }

  timeoutMs(ms: number): this {
    this._timeoutMs = ms;
    return this;
  }

  build(): RpcClient {
    const url = this._url ?? process.env.ORBITFLARE_RPC_URL;
    if (!url) {
      throw OrbitflareError.config(
        'no RPC URL provided. Pass .url() to the builder or set ORBITFLARE_RPC_URL in your environment',
      );
    }

    return new RpcClient({
      endpoints: new EndpointSet(url, this._fallbacks),
      apiKey: this._apiKey,
      commitment: this._commitment,
      retry: this._retry,
      timeoutMs: this._timeoutMs,
      logger: resolveLogger(this._logger, this._logLevel),
    });
  }
}

export { sanitizeUrl };
