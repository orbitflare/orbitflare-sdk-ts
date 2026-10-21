import {
  type ClientDuplexStream,
  type ClientOptions,
  type ClientReadableStream,
  type ServiceError,
} from '@grpc/grpc-js';

import { apiKeyInterceptors, parseAddress } from '../address.js';
import { EndpointSet } from '../endpoint.js';
import { OrbitflareError, sanitizeUrl } from '../error.js';
import { type Logger, type LogLevel, resolveLogger } from '../logger.js';
import {
  defaultRetryPolicy,
  delayForAttempt,
  hasAttemptsLeft,
  type RetryPolicy,
} from '../retry.js';
import {
  JetstreamV2Client as ProtoV2Client,
  type SlotEvent,
  type SubscribeTransactionsRequest,
  type SubscribeTransactionsResponse,
  type TxFilter,
} from '../proto/jetstream_v2.js';

export type { SlotEvent, SubscribeTransactionsResponse, TxFilter } from '../proto/jetstream_v2.js';

const DEFAULT_PING_INTERVAL_SECS = 10;
const DEFAULT_MAX_MISSED_PONGS = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TransactionFilter {
  private _accountInclude: string[] = [];
  private _accountExclude: string[] = [];
  private _accountRequired: string[] = [];
  private _includeEnrichment = false;

  accountInclude(accounts: string[]): this {
    this._accountInclude.push(...accounts);
    return this;
  }

  accountExclude(accounts: string[]): this {
    this._accountExclude.push(...accounts);
    return this;
  }

  accountRequired(accounts: string[]): this {
    this._accountRequired.push(...accounts);
    return this;
  }

  includeEnrichment(value: boolean): this {
    this._includeEnrichment = value;
    return this;
  }

  withId(filterId: string): TxFilter {
    return {
      filterId,
      filter: {
        accountInclude: this._accountInclude,
        accountExclude: this._accountExclude,
        accountRequired: this._accountRequired,
        includeEnrichment: this._includeEnrichment,
      },
    };
  }
}

interface JetstreamClientOptions {
  endpoints: EndpointSet;
  apiKey?: string;
  retry: RetryPolicy;
  timeoutSecs: number;
  keepaliveSecs: number;
  pingIntervalSecs: number;
  maxMissedPongs: number;
  channelCapacity: number;
  logger: Logger;
}

export class TxFilterHandle {
  constructor(private readonly stream: TransactionStream) {}

  addFilters(filters: TxFilter[]): void {
    this.stream.addFilters(filters);
  }

  removeFilters(filterIds: string[]): void {
    this.stream.removeFilters(filterIds);
  }

  ping(pingId: number): void {
    this.stream.ping(pingId);
  }
}

export class TransactionStream {
  private buffer: SubscribeTransactionsResponse[] = [];
  private waiting: ((v: SubscribeTransactionsResponse | undefined) => void)[] = [];
  private errored?: OrbitflareError;
  private closed = false;
  private shutdownRequested = false;
  private active = new Map<string, TxFilter>();
  private call?: ClientDuplexStream<SubscribeTransactionsRequest, SubscribeTransactionsResponse>;

  constructor(initial: TxFilter[]) {
    for (const f of initial) this.active.set(f.filterId, f);
  }

  async next(): Promise<SubscribeTransactionsResponse | undefined> {
    if (this.buffer.length > 0) return this.buffer.shift();
    if (this.errored) throw this.errored;
    if (this.closed) return undefined;
    return new Promise<SubscribeTransactionsResponse | undefined>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<SubscribeTransactionsResponse> {
    while (true) {
      const v = await this.next();
      if (v === undefined) return;
      yield v;
    }
  }

  handle(): TxFilterHandle {
    return new TxFilterHandle(this);
  }

  addFilters(filters: TxFilter[]): void {
    for (const f of filters) this.active.set(f.filterId, f);
    this._write({ addFilters: { filters } });
  }

  removeFilters(filterIds: string[]): void {
    for (const id of filterIds) this.active.delete(id);
    this._write({ removeFilters: { filterIds } });
  }

  ping(pingId: number): void {
    this._write({ ping: { pingId } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shutdownRequested = true;
    while (this.waiting.length > 0) this.waiting.shift()!(undefined);
  }

  _activeFilters(): TxFilter[] {
    return [...this.active.values()];
  }

  _shouldShutdown(): boolean {
    return this.shutdownRequested;
  }

  _setCall(
    call:
      ClientDuplexStream<SubscribeTransactionsRequest, SubscribeTransactionsResponse> | undefined,
  ): void {
    this.call = call;
  }

  _write(req: SubscribeTransactionsRequest): void {
    if (this.closed || !this.call) return;
    try {
      this.call.write(req);
    } catch {}
  }

  _push(resp: SubscribeTransactionsResponse): void {
    if (this.closed) return;
    if (this.waiting.length > 0) {
      this.waiting.shift()!(resp);
    } else {
      this.buffer.push(resp);
    }
  }

  _fail(err: OrbitflareError): void {
    if (this.closed) return;
    this.errored = err;
    this.closed = true;
    while (this.waiting.length > 0) this.waiting.shift()!(undefined);
  }
}

export class SlotStream {
  private buffer: SlotEvent[] = [];
  private waiting: ((v: SlotEvent | undefined) => void)[] = [];
  private errored?: OrbitflareError;
  private closed = false;
  private shutdownRequested = false;

  async next(): Promise<SlotEvent | undefined> {
    if (this.buffer.length > 0) return this.buffer.shift();
    if (this.errored) throw this.errored;
    if (this.closed) return undefined;
    return new Promise<SlotEvent | undefined>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<SlotEvent> {
    while (true) {
      const v = await this.next();
      if (v === undefined) return;
      yield v;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shutdownRequested = true;
    while (this.waiting.length > 0) this.waiting.shift()!(undefined);
  }

  _shouldShutdown(): boolean {
    return this.shutdownRequested;
  }

  _push(event: SlotEvent): void {
    if (this.closed) return;
    if (this.waiting.length > 0) {
      this.waiting.shift()!(event);
    } else {
      this.buffer.push(event);
    }
  }

  _fail(err: OrbitflareError): void {
    if (this.closed) return;
    this.errored = err;
    this.closed = true;
    while (this.waiting.length > 0) this.waiting.shift()!(undefined);
  }
}

export class JetstreamClient {
  constructor(private readonly opts: JetstreamClientOptions) {}

  static filter(filterId: string, accountInclude: string[]): TxFilter {
    return {
      filterId,
      filter: {
        accountInclude,
        accountExclude: [],
        accountRequired: [],
        includeEnrichment: false,
      },
    };
  }

  subscribeTransactions(filters: TxFilter[]): TransactionStream {
    const stream = new TransactionStream(filters);
    void this.driveTransactions(stream);
    return stream;
  }

  subscribeSlots(): SlotStream {
    const stream = new SlotStream();
    void this.driveSlots(stream);
    return stream;
  }

  async ping(count: number): Promise<number> {
    return unaryWithFailover(
      this.opts,
      (client) =>
        new Promise<number>((resolve, reject) => {
          client.ping({ count }, (err: ServiceError | null, resp) => {
            if (err) reject(toGrpcError(err));
            else resolve(resp.count);
          });
        }),
    );
  }

  async getVersion(): Promise<string> {
    return unaryWithFailover(
      this.opts,
      (client) =>
        new Promise<string>((resolve, reject) => {
          client.getVersion({}, (err: ServiceError | null, resp) => {
            if (err) reject(toGrpcError(err));
            else resolve(resp.version);
          });
        }),
    );
  }

  private async driveTransactions(stream: TransactionStream): Promise<void> {
    const { logger } = this.opts;
    let attempt = 0;
    while (!stream._shouldShutdown()) {
      attempt += 1;
      const idx = this.opts.endpoints.pick();
      const url = this.opts.endpoints.get(idx);
      logger.info('connecting (jetstream-v2 transactions)', {
        endpoint: sanitizeUrl(url),
        attempt,
      });

      try {
        await runTxConnection(url, stream, this.opts, () => {
          attempt = 0;
          logger.info('connected, streaming (jetstream-v2 transactions)');
        });
        this.opts.endpoints.markSuccess(idx);
        return;
      } catch (e) {
        this.opts.endpoints.markFailure(idx);
        const err = e instanceof OrbitflareError ? e : OrbitflareError.transport(e);
        if (!hasAttemptsLeft(this.opts.retry, attempt)) {
          stream._fail(err.withEndpoint(url));
          return;
        }
        const delayMs = delayForAttempt(this.opts.retry, attempt);
        logger.warn('reconnecting (jetstream-v2 transactions)', {
          error: err,
          endpoint: sanitizeUrl(url),
          attempt,
          delayMs,
        });
        await sleep(delayMs);
      }
    }
  }

  private async driveSlots(stream: SlotStream): Promise<void> {
    const { logger } = this.opts;
    let attempt = 0;
    while (!stream._shouldShutdown()) {
      attempt += 1;
      const idx = this.opts.endpoints.pick();
      const url = this.opts.endpoints.get(idx);
      logger.info('connecting (jetstream-v2 slots)', { endpoint: sanitizeUrl(url), attempt });

      try {
        await runSlotConnection(url, stream, this.opts, () => {
          attempt = 0;
          logger.info('connected, streaming (jetstream-v2 slots)');
        });
        this.opts.endpoints.markSuccess(idx);
        return;
      } catch (e) {
        this.opts.endpoints.markFailure(idx);
        const err = e instanceof OrbitflareError ? e : OrbitflareError.transport(e);
        if (!hasAttemptsLeft(this.opts.retry, attempt)) {
          stream._fail(err.withEndpoint(url));
          return;
        }
        const delayMs = delayForAttempt(this.opts.retry, attempt);
        logger.warn('reconnecting (jetstream-v2 slots)', {
          error: err,
          endpoint: sanitizeUrl(url),
          attempt,
          delayMs,
        });
        await sleep(delayMs);
      }
    }
  }
}

function makeClient(url: string, opts: JetstreamClientOptions): ProtoV2Client {
  const { target, credentials } = parseAddress(url);
  const clientOpts: Partial<ClientOptions> = {
    interceptors: apiKeyInterceptors(opts.apiKey),
    'grpc.keepalive_time_ms': opts.keepaliveSecs * 1000,
    'grpc.keepalive_timeout_ms': opts.timeoutSecs * 1000,
    'grpc.keepalive_permit_without_calls': 1,
  };
  return new ProtoV2Client(target, credentials, clientOpts);
}

async function unaryWithFailover<T>(
  opts: JetstreamClientOptions,
  call: (client: ProtoV2Client) => Promise<T>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const idx = opts.endpoints.pick();
    const url = opts.endpoints.get(idx);
    const client = makeClient(url, opts);
    try {
      const result = await call(client);
      opts.endpoints.markSuccess(idx);
      client.close();
      return result;
    } catch (e) {
      client.close();
      opts.endpoints.markFailure(idx);
      const err = e instanceof OrbitflareError ? e : OrbitflareError.transport(e);
      if (!hasAttemptsLeft(opts.retry, attempt)) throw err.withEndpoint(url);
      const delayMs = delayForAttempt(opts.retry, attempt);
      opts.logger.warn('retrying (jetstream-v2 unary)', {
        error: err,
        endpoint: sanitizeUrl(url),
        attempt,
        delayMs,
      });
      await sleep(delayMs);
    }
  }
}

async function runTxConnection(
  url: string,
  stream: TransactionStream,
  opts: JetstreamClientOptions,
  onConnected: () => void,
): Promise<void> {
  const client = makeClient(url, opts);

  let call: ClientDuplexStream<SubscribeTransactionsRequest, SubscribeTransactionsResponse>;
  try {
    call = client.subscribeTransactions();
  } catch (e) {
    client.close();
    throw OrbitflareError.transport(e);
  }
  stream._setCall(call);

  let intervalsSinceTraffic = 0;
  let pingId = 1;
  let connected = false;
  let pingTimer: NodeJS.Timeout | undefined;
  let resolveDone: () => void;
  let rejectDone: (err: OrbitflareError) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const cleanup = () => {
    if (pingTimer) clearInterval(pingTimer);
    stream._setCall(undefined);
    try {
      call.end();
    } catch {}
    client.close();
  };

  call.on('data', (resp: SubscribeTransactionsResponse) => {
    if (!connected) {
      connected = true;
      onConnected();
    }
    intervalsSinceTraffic = 0;
    stream._push(resp);
  });
  call.on('error', (e) => {
    cleanup();
    rejectDone(toGrpcError(e));
  });
  call.on('end', () => {
    cleanup();
    rejectDone(OrbitflareError.stream('stream ended'));
  });

  const active = stream._activeFilters();
  if (active.length > 0) {
    try {
      call.write({ addFilters: { filters: active } });
    } catch (e) {
      cleanup();
      throw OrbitflareError.transport(e);
    }
  }

  pingTimer = setInterval(() => {
    if (stream._shouldShutdown()) {
      cleanup();
      resolveDone();
      return;
    }
    if (intervalsSinceTraffic >= opts.maxMissedPongs) {
      cleanup();
      rejectDone(OrbitflareError.stream(`no traffic after ${opts.maxMissedPongs} pings`));
      return;
    }
    try {
      call.write({ ping: { pingId } });
      pingId = (pingId + 1) | 0;
      intervalsSinceTraffic += 1;
    } catch {
      cleanup();
      rejectDone(OrbitflareError.stream('outbound closed'));
    }
  }, opts.pingIntervalSecs * 1000);

  await done;
}

async function runSlotConnection(
  url: string,
  stream: SlotStream,
  opts: JetstreamClientOptions,
  onConnected: () => void,
): Promise<void> {
  const client = makeClient(url, opts);

  let call: ClientReadableStream<SlotEvent>;
  try {
    call = client.subscribeSlots({});
  } catch (e) {
    client.close();
    throw OrbitflareError.transport(e);
  }

  let shutdownTimer: NodeJS.Timeout | undefined;
  let resolveDone: () => void;
  let rejectDone: (err: OrbitflareError) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const cleanup = () => {
    if (shutdownTimer) clearInterval(shutdownTimer);
    try {
      call.cancel();
    } catch {}
    client.close();
  };

  let connected = false;
  call.on('data', (event: SlotEvent) => {
    if (!connected) {
      connected = true;
      onConnected();
    }
    stream._push(event);
  });
  call.on('error', (e) => {
    cleanup();
    rejectDone(toGrpcError(e));
  });
  call.on('end', () => {
    cleanup();
    rejectDone(OrbitflareError.stream('stream ended'));
  });

  shutdownTimer = setInterval(() => {
    if (stream._shouldShutdown()) {
      cleanup();
      resolveDone();
    }
  }, 1000);

  await done;
}

function toGrpcError(e: any): OrbitflareError {
  const code = typeof e?.code === 'number' ? e.code : 2;
  const message = typeof e?.details === 'string' ? e.details : (e?.message ?? 'grpc error');
  return OrbitflareError.grpc(code, message);
}

export class JetstreamClientBuilder {
  private _url?: string;
  private _fallbacks: string[] = [];
  private _apiKey?: string;
  private _retry: RetryPolicy = defaultRetryPolicy();
  private _timeoutSecs = 30;
  private _keepaliveSecs = 60;
  private _pingIntervalSecs = DEFAULT_PING_INTERVAL_SECS;
  private _maxMissedPongs = DEFAULT_MAX_MISSED_PONGS;
  private _channelCapacity = 4096;
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

  retry(policy: RetryPolicy): this {
    this._retry = policy;
    return this;
  }

  timeoutSecs(secs: number): this {
    this._timeoutSecs = secs;
    return this;
  }

  keepaliveSecs(secs: number): this {
    this._keepaliveSecs = secs;
    return this;
  }

  pingIntervalSecs(secs: number): this {
    this._pingIntervalSecs = secs;
    return this;
  }

  maxMissedPongs(n: number): this {
    this._maxMissedPongs = n;
    return this;
  }

  channelCapacity(cap: number): this {
    this._channelCapacity = cap;
    return this;
  }

  build(): JetstreamClient {
    const url = this._url ?? process.env.ORBITFLARE_JETSTREAM_URL;
    if (!url) {
      throw OrbitflareError.config(
        'no JetStream URL provided. Pass .url() to the builder or set ORBITFLARE_JETSTREAM_URL in your environment',
      );
    }
    return new JetstreamClient({
      endpoints: new EndpointSet(url, this._fallbacks),
      apiKey: this._apiKey ?? process.env.ORBITFLARE_LICENSE_KEY,
      retry: this._retry,
      timeoutSecs: this._timeoutSecs,
      keepaliveSecs: this._keepaliveSecs,
      pingIntervalSecs: this._pingIntervalSecs,
      maxMissedPongs: this._maxMissedPongs,
      channelCapacity: this._channelCapacity,
      logger: resolveLogger(this._logger, this._logLevel),
    });
  }
}
