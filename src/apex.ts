import { createPrivateKey, createPublicKey, hkdfSync } from 'node:crypto';

import { EndpointSet } from './endpoint.js';
import { OrbitflareError, sanitizeUrl } from './error.js';
import { type Logger, type LogLevel, resolveLogger } from './logger.js';
import { delayForAttempt, hasAttemptsLeft, type RetryPolicy } from './retry.js';
import type { RpcClient } from './rpc.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type ApexRegion =
  'fra' | 'ams' | 'dub' | 'lon' | 'nyc' | 'slc' | 'sgp' | 'tyo' | 'sqq' | 'global';

export const APEX_REGIONS: readonly ApexRegion[] = [
  'fra',
  'ams',
  'dub',
  'lon',
  'nyc',
  'slc',
  'sgp',
  'tyo',
  'sqq',
  'global',
];

export const APEX_MIN_TIP_LAMPORTS = 1_000_000;
export const APEX_DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 10_000;
export const APEX_MAX_TRANSACTION_SIZE = 4096;
export const APEX_MAX_BATCH = 16;
export const APEX_MAX_BUNDLE = 4;
export const APEX_TIP_PROGRAM_ID = '9ig7pd4gqe2m16ACGPbPo4HfMGD3ba38poDhXEayx7EF';

const REGION_ALIASES: Record<string, ApexRegion> = {
  fra: 'fra',
  frankfurt: 'fra',
  ams: 'ams',
  amsterdam: 'ams',
  dub: 'dub',
  dublin: 'dub',
  lon: 'lon',
  london: 'lon',
  nyc: 'nyc',
  ny: 'nyc',
  newyork: 'nyc',
  'new-york': 'nyc',
  slc: 'slc',
  saltlakecity: 'slc',
  'salt-lake-city': 'slc',
  sgp: 'sgp',
  sin: 'sgp',
  singapore: 'sgp',
  tyo: 'tyo',
  tokyo: 'tyo',
  sqq: 'sqq',
  siauliai: 'sqq',
  global: 'global',
  auto: 'global',
};

export function parseApexRegion(value: string): ApexRegion | undefined {
  return REGION_ALIASES[value.toLowerCase()];
}

export function apexUrl(region: ApexRegion): string {
  return `http://${region}.apex.orbitflare.com`;
}

export interface ApexSendOptions {
  mevProtect?: boolean;
  maxRetries?: number;
}

export interface ApexBatchItem {
  accepted: boolean;
  signature?: string;
  error?: string;
  message?: string;
}

export interface ApexBatchResult {
  attempted: number;
  accepted: number;
  rejected: number;
  results: ApexBatchItem[];
}

export interface ApexBundleAccepted {
  bundleId: string;
  signatures: string[];
}

export type ApexBundleState = 'Pending' | 'Landed' | 'Failed' | 'Invalid';

export interface ApexBundleStatus {
  bundleId: string;
  state: ApexBundleState;
  landedSlot: number | null;
}

export type ApexTransactionBytes = ArrayBufferView | ArrayBuffer;

function toBytes(tx: ApexTransactionBytes): Uint8Array {
  if (tx instanceof Uint8Array) return tx;
  if (ArrayBuffer.isView(tx)) return new Uint8Array(tx.buffer, tx.byteOffset, tx.byteLength);
  return new Uint8Array(tx);
}

export function encodeApexFrames(transactions: ApexTransactionBytes[]): Uint8Array {
  let size = 0;
  const parts = transactions.map(toBytes);
  for (const p of parts) {
    if (p.length === 0 || p.length > APEX_MAX_TRANSACTION_SIZE) {
      throw OrbitflareError.config(
        `transaction of ${p.length} bytes is outside 1..${APEX_MAX_TRANSACTION_SIZE}`,
      );
    }
    size += p.length + 2;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out[offset] = p.length >> 8;
    out[offset + 1] = p.length & 0xff;
    out.set(p, offset + 2);
    offset += p.length + 2;
  }
  return out;
}

export function pickApexTipAccount(tipAccounts: readonly string[]): string {
  const account = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
  if (!account) throw OrbitflareError.config('no tip accounts to pick from');
  return account;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export function apexClientPubkey(apiKey: string): string {
  const seed = new Uint8Array(
    hkdfSync(
      'sha256',
      Buffer.from(apiKey, 'utf8'),
      Buffer.from('orbitflare-apex', 'utf8'),
      Buffer.from('orbitflare-apex/quic-client-cert/v1', 'utf8'),
      32,
    ),
  );
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  der.set(PKCS8_ED25519_PREFIX);
  der.set(seed, PKCS8_ED25519_PREFIX.length);
  const key = createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  return base58(Buffer.from(jwk.x as string, 'base64url'));
}

function toOrbitflareError(e: unknown): OrbitflareError {
  if (e instanceof OrbitflareError) return e;
  if (e instanceof Error) return OrbitflareError.transport(e);
  return OrbitflareError.transport(new Error(String(e)));
}

export class ApexClient {
  private readonly endpoints: EndpointSet;
  private readonly apiKey: string;
  private readonly mevProtect: boolean;
  private readonly maxRetries: number | undefined;
  private readonly retry: RetryPolicy;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(opts: {
    endpoints: EndpointSet;
    apiKey: string;
    mevProtect: boolean;
    maxRetries: number | undefined;
    retry: RetryPolicy;
    timeoutMs: number;
    logger: Logger;
  }) {
    this.endpoints = opts.endpoints;
    this.apiKey = opts.apiKey;
    this.mevProtect = opts.mevProtect;
    this.maxRetries = opts.maxRetries;
    this.retry = opts.retry;
    this.timeoutMs = opts.timeoutMs;
    this.logger = opts.logger;
  }

  async getTipAccounts(): Promise<string[]> {
    const r = await this.jsonRpc('getTipAccounts', []);
    if (!Array.isArray(r)) throw OrbitflareError.serialization('expected array of tip accounts');
    return r.filter((v): v is string => typeof v === 'string');
  }

  async sendTransaction(
    tx: ApexTransactionBytes | string,
    opts: ApexSendOptions = {},
  ): Promise<string> {
    const txBase64 = typeof tx === 'string' ? tx : Buffer.from(toBytes(tx)).toString('base64');
    const config: Record<string, unknown> = { encoding: 'base64' };
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    if (maxRetries !== undefined) config.maxRetries = maxRetries;
    const r = await this.jsonRpc('sendTransaction', [
      txBase64,
      config,
      opts.mevProtect ?? this.mevProtect,
    ]);
    if (typeof r !== 'string') throw OrbitflareError.serialization('expected signature string');
    return r;
  }

  async sendTransactionBinary(
    tx: ApexTransactionBytes,
    opts: ApexSendOptions = {},
  ): Promise<string> {
    const bytes = toBytes(tx);
    if (bytes.length === 0 || bytes.length > APEX_MAX_TRANSACTION_SIZE) {
      throw OrbitflareError.config(
        `transaction of ${bytes.length} bytes is outside 1..${APEX_MAX_TRANSACTION_SIZE}`,
      );
    }
    const v = await this.binary(this.route('/send-bin', opts), bytes, '/send-bin');
    if (typeof v.signature !== 'string') throw OrbitflareError.serialization('expected signature');
    return v.signature;
  }

  async sendBatch(
    transactions: ApexTransactionBytes[],
    opts: ApexSendOptions = {},
  ): Promise<ApexBatchResult> {
    if (transactions.length === 0 || transactions.length > APEX_MAX_BATCH) {
      throw OrbitflareError.config(`a batch holds 1..${APEX_MAX_BATCH} transactions`);
    }
    const v = await this.binary(
      this.route('/send-batch', opts),
      encodeApexFrames(transactions),
      '/send-batch',
    );
    if (!Array.isArray(v.results)) throw OrbitflareError.serialization('expected batch results');
    return {
      attempted: Number(v.attempted ?? 0),
      accepted: Number(v.accepted ?? 0),
      rejected: Number(v.rejected ?? 0),
      results: v.results.map((r: any) =>
        typeof r?.signature === 'string'
          ? { accepted: true, signature: r.signature }
          : {
              accepted: false,
              error: String(r?.error ?? 'error'),
              message: String(r?.message ?? ''),
            },
      ),
    };
  }

  async sendBundle(transactions: ApexTransactionBytes[]): Promise<ApexBundleAccepted> {
    if (transactions.length === 0 || transactions.length > APEX_MAX_BUNDLE) {
      throw OrbitflareError.config(`a bundle holds 1..${APEX_MAX_BUNDLE} transactions`);
    }
    const v = await this.binary('/send-bundle', encodeApexFrames(transactions), '/send-bundle');
    if (typeof v.bundle_id !== 'string') throw OrbitflareError.serialization('expected bundle_id');
    return {
      bundleId: v.bundle_id,
      signatures: Array.isArray(v.signatures)
        ? v.signatures.filter((s: unknown): s is string => typeof s === 'string')
        : [],
    };
  }

  async getBundleStatuses(bundleIds: string[]): Promise<ApexBundleStatus[]> {
    const r = await this.jsonRpc('getInflightBundleStatuses', [bundleIds]);
    if (!Array.isArray(r?.value)) throw OrbitflareError.serialization('expected bundle statuses');
    return r.value.map((s: any) => {
      const status = s?.status;
      const state: ApexBundleState =
        status === 'Landed' || status === 'Failed' || status === 'Pending' ? status : 'Invalid';
      return {
        bundleId: String(s?.bundle_id ?? ''),
        state,
        landedSlot: typeof s?.landed_slot === 'number' ? s.landed_slot : null,
      };
    });
  }

  async ping(): Promise<void> {
    await this.execute('ping', async (base) => {
      const resp = await this.fetchWithTimeout(`${base}/ping`, { method: 'GET' });
      const text = await resp.text();
      if (resp.status !== 200 || text !== 'pong') {
        throw OrbitflareError.transport(new Error(`ping: HTTP ${resp.status} ${text.trim()}`));
      }
    });
  }

  private route(path: string, opts: ApexSendOptions): string {
    const mev = (opts.mevProtect ?? this.mevProtect) ? 1 : 0;
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    return maxRetries === undefined
      ? `${path}?mev_protect=${mev}`
      : `${path}?mev_protect=${mev}&max_retries=${maxRetries}`;
  }

  private async jsonRpc(method: string, params: unknown[]): Promise<any> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    return this.execute(method, async (base) => {
      const resp = await this.fetchWithTimeout(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body,
      });
      const parsed = await this.parse(resp);
      if (parsed?.error) {
        const code = typeof parsed.error.code === 'number' ? parsed.error.code : 0;
        const message =
          typeof parsed.error.message === 'string' ? parsed.error.message : 'unknown rpc error';
        throw OrbitflareError.rpc(code, message);
      }
      return parsed?.result;
    });
  }

  private async binary(pathAndQuery: string, body: Uint8Array, label: string): Promise<any> {
    return this.execute(label, async (base) => {
      const resp = await this.fetchWithTimeout(`${base}${pathAndQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-api-key': this.apiKey },
        body,
      });
      const parsed = await this.parse(resp);
      if (resp.status >= 200 && resp.status < 300) return parsed;
      throw OrbitflareError.apex(
        resp.status,
        typeof parsed?.error === 'string' ? parsed.error : 'error',
        typeof parsed?.message === 'string' ? parsed.message : '',
      );
    });
  }

  private async parse(resp: Response): Promise<any> {
    if (resp.status === 429) {
      const header = resp.headers.get('retry-after');
      const secs = header ? Number.parseInt(header, 10) : NaN;
      await resp.text().catch(() => undefined);
      throw OrbitflareError.rateLimited(Number.isFinite(secs) ? secs * 1000 : undefined);
    }
    const text = await resp.text();
    if (resp.status >= 500 && resp.status !== 503) {
      throw OrbitflareError.transport(new Error(`HTTP ${resp.status}: ${text.trim()}`));
    }
    try {
      return JSON.parse(text);
    } catch {
      throw OrbitflareError.rpc(-resp.status, text.trim());
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (e: any) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') throw OrbitflareError.timeout();
      throw OrbitflareError.transport(e);
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute<T>(label: string, call: (base: string) => Promise<T>): Promise<T> {
    let lastErr: OrbitflareError | undefined;
    let tried = 0;
    while (tried < this.endpoints.length) {
      const idx = this.endpoints.pick();
      const base = this.endpoints.get(idx).replace(/\/+$/, '');
      tried += 1;
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          const result = await call(base);
          this.endpoints.markSuccess(idx);
          return result;
        } catch (raw) {
          const err = toOrbitflareError(raw);
          if (!err.isRetryable()) {
            if (err.kind === 'apex' || err.kind === 'rpc') throw err.withEndpoint(base);
            this.endpoints.markFailure(idx);
            lastErr = err.withEndpoint(base);
            break;
          }
          if (hasAttemptsLeft(this.retry, attempt)) {
            const delayMs = err.retryAfter() ?? delayForAttempt(this.retry, attempt);
            this.logger.warn('retrying', { method: label, attempt, delayMs, error: err });
            await sleep(delayMs);
            continue;
          }
          this.endpoints.markFailure(idx);
          this.logger.warn('failing over', {
            method: label,
            endpoint: sanitizeUrl(base),
            error: err,
          });
          lastErr = err.withEndpoint(base);
          break;
        }
      }
    }
    throw lastErr ?? OrbitflareError.transport(new Error('all endpoints exhausted'));
  }
}

export class ApexClientBuilder {
  private _url?: string;
  private _fallbacks: string[] = [];
  private _apiKey?: string;
  private _mevProtect = false;
  private _maxRetries?: number;
  private _retry: RetryPolicy = {
    initialDelayMs: 50,
    maxDelayMs: 1_000,
    multiplier: 2.0,
    maxAttempts: 1,
  };
  private _timeoutMs = 5_000;
  private _logger?: Logger;
  private _logLevel?: LogLevel;

  region(region: ApexRegion): this {
    this._url = apexUrl(region);
    return this;
  }

  fallbackRegion(region: ApexRegion): this {
    this._fallbacks.push(apexUrl(region));
    return this;
  }

  url(url: string): this {
    this._url = url;
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

  apiKey(key: string): this {
    this._apiKey = key;
    return this;
  }

  mevProtect(enabled: boolean): this {
    this._mevProtect = enabled;
    return this;
  }

  maxRetries(n: number): this {
    this._maxRetries = n;
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

  logger(logger: Logger): this {
    this._logger = logger;
    return this;
  }

  logLevel(level: LogLevel): this {
    this._logLevel = level;
    return this;
  }

  build(): ApexClient {
    const apiKey = this._apiKey ?? process.env.ORBITFLARE_APEX_API_KEY;
    if (!apiKey) {
      throw OrbitflareError.config(
        'no Apex API key provided. Pass .apiKey() to the builder or set ORBITFLARE_APEX_API_KEY in your environment',
      );
    }
    const envRegion = process.env.ORBITFLARE_APEX_REGION;
    let url = this._url ?? process.env.ORBITFLARE_APEX_URL;
    if (!url && envRegion) {
      const region = parseApexRegion(envRegion);
      if (!region) throw OrbitflareError.config(`unknown ORBITFLARE_APEX_REGION ${envRegion}`);
      url = apexUrl(region);
    }
    return new ApexClient({
      endpoints: new EndpointSet(url ?? apexUrl('fra'), this._fallbacks),
      apiKey,
      mevProtect: this._mevProtect,
      maxRetries: this._maxRetries,
      retry: this._retry,
      timeoutMs: this._timeoutMs,
      logger: resolveLogger(this._logger, this._logLevel),
    });
  }
}

export async function fetchApexVaults(rpc: RpcClient): Promise<string[]> {
  const r = await rpc.request<any[]>('getProgramAccounts', [
    APEX_TIP_PROGRAM_ID,
    {
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { dataSize: 41 },
        { memcmp: { offset: 0, bytes: 'QVBFWFZMVDE=', encoding: 'base64' } },
      ],
    },
  ]);
  if (!Array.isArray(r)) throw OrbitflareError.serialization('expected array');
  return r
    .map((row) => row?.pubkey)
    .filter((k): k is string => typeof k === 'string')
    .sort();
}

export async function waitForConfirmation(
  rpc: RpcClient,
  signature: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<number | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const pollMs = opts.pollMs ?? 500;
  while (true) {
    const r = await rpc.request<any>('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: false },
    ]);
    const status = Array.isArray(r?.value) ? r.value[0] : null;
    if (status) {
      if (status.err != null) {
        throw OrbitflareError.rpc(0, `transaction failed on chain: ${JSON.stringify(status.err)}`);
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return typeof status.slot === 'number' ? status.slot : null;
      }
    }
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}
