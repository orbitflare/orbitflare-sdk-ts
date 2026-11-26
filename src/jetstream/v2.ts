import {
  type ClientDuplexStream,
  type ClientReadableStream,
  type ServiceError,
} from '@grpc/grpc-js';

import { parseAddress } from '../address.js';
import { EndpointSet } from '../endpoint.js';
import { OrbitflareError, sanitizeUrl } from '../error.js';
import { type ConnectionEvents } from '../events.js';
import { type Logger, type LogLevel, resolveLogger } from '../logger.js';
import {
  defaultRetryPolicy,
  delayForAttempt,
  hasAttemptsLeft,
  type RetryPolicy,
} from '../retry.js';
import {
  clientOptions,
  DEFAULT_KEEPALIVE_SECS,
  DEFAULT_MAX_DECODING_MESSAGE_SIZE,
  DEFAULT_MAX_MISSED_PONGS,
  DEFAULT_PING_INTERVAL_SECS,
  Inbox,
  Reconnector,
  sleep,
  type StreamOptions,
  toGrpcError,
} from '../streaming.js';
import {
  JetstreamV2Client as ProtoV2Client,
  type SlotEvent,
  type SubscribeSlotsRequest,
  type SubscribeTransactionsRequest,
  type SubscribeTransactionsResponse,
  type TxFilter,
} from '../proto/jetstream_v2.js';

export type { SlotEvent, SubscribeTransactionsResponse, TxFilter } from '../proto/jetstream_v2.js';
export { SlotStatus } from '../proto/jetstream_v2.js';
export { ConnectionEvents, type ConnectionEvent } from '../events.js';

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
  private inbox = new Inbox<SubscribeTransactionsResponse>();
  private active = new Map<string, TxFilter>();
  private call?: ClientDuplexStream<SubscribeTransactionsRequest, SubscribeTransactionsResponse>;
  private abort?: () => void;

  constructor(
    private readonly rc: Reconnector,
    initial: TxFilter[],
  ) {
    for (const f of initial) this.active.set(f.filterId, f);
  }

  next(): Promise<SubscribeTransactionsResponse | undefined> {
    return this.inbox.next();
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

  events(): ConnectionEvents {
    return this.rc.events.subscribe();
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
    if (!this.inbox.close()) return;
    this.rc.stop();
    this.abort?.();
  }

  _activeFilters(): TxFilter[] {
    return [...this.active.values()];
  }

  _attach(
    call:
      ClientDuplexStream<SubscribeTransactionsRequest, SubscribeTransactionsResponse> | undefined,
    abort?: () => void,
  ): void {
    this.call = call;
    this.abort = abort;
  }

  _write(req: SubscribeTransactionsRequest): void {
    if (this.inbox.closed || !this.call) return;
    try {
      this.call.write(req);
    } catch {}
  }

  _push(resp: SubscribeTransactionsResponse): void {
    this.inbox.push(resp);
  }

  _fail(err: OrbitflareError): void {
    this.inbox.fail(err);
  }
}

export class SlotStream {
  private inbox = new Inbox<SlotEvent>();
  private abort?: () => void;

  constructor(private readonly rc: Reconnector) {}

  next(): Promise<SlotEvent | undefined> {
    return this.inbox.next();
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<SlotEvent> {
    while (true) {
      const v = await this.next();
      if (v === undefined) return;
      yield v;
    }
  }

  events(): ConnectionEvents {
    return this.rc.events.subscribe();
  }

  close(): void {
    if (!this.inbox.close()) return;
    this.rc.stop();
    this.abort?.();
  }

  _onAbort(abort: (() => void) | undefined): void {
    this.abort = abort;
  }

  _push(event: SlotEvent): void {
    this.inbox.push(event);
  }

  _fail(err: OrbitflareError): void {
    this.inbox.fail(err);
  }
}

export class JetstreamClient {
  constructor(private readonly opts: StreamOptions) {}

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
    const rc = new Reconnector(this.opts, 'jetstream-v2 transactions');
    const stream = new TransactionStream(rc, filters);
    void rc.run(
      (url, idx) => runTxConnection(url, idx, rc, stream),
      (err) => stream._fail(err),
    );
    return stream;
  }

  subscribeSlots(): SlotStream {
    return this.subscribeSlotsWith({ includeBlockFooter: false });
  }

  subscribeSlotsWithBlockFooters(): SlotStream {
    return this.subscribeSlotsWith({ includeBlockFooter: true });
  }

  private subscribeSlotsWith(request: SubscribeSlotsRequest): SlotStream {
    const rc = new Reconnector(this.opts, 'jetstream-v2 slots');
    const stream = new SlotStream(rc);
    void rc.run(
      (url, idx) => runSlotConnection(url, idx, rc, request, stream),
      (err) => stream._fail(err),
    );
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
}

function makeClient(url: string, opts: StreamOptions): ProtoV2Client {
  const { target, credentials } = parseAddress(url);
  return new ProtoV2Client(target, credentials, clientOptions(opts));
}

async function unaryWithFailover<T>(
  opts: StreamOptions,
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
  idx: number,
  rc: Reconnector,
  stream: TransactionStream,
): Promise<void> {
  const client = makeClient(url, rc.opts);

  let call: ClientDuplexStream<SubscribeTransactionsRequest, SubscribeTransactionsResponse>;
  try {
    call = client.subscribeTransactions();
  } catch (e) {
    client.close();
    throw OrbitflareError.transport(e);
  }

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
    stream._attach(undefined);
    try {
      call.cancel();
    } catch {}
    client.close();
  };

  const markConnected = () => {
    if (connected) return;
    connected = true;
    rc.onConnected(idx);
  };

  call.on('metadata', markConnected);
  call.on('data', (resp: SubscribeTransactionsResponse) => {
    markConnected();
    intervalsSinceTraffic = 0;
    rc.onMessage();
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

  stream._attach(call, () => {
    resolveDone();
    cleanup();
  });
  if (rc.shouldStop) {
    resolveDone!();
    cleanup();
  }
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
    if (rc.shouldStop) {
      resolveDone();
      cleanup();
      return;
    }
    if (intervalsSinceTraffic >= rc.opts.maxMissedPongs) {
      cleanup();
      rejectDone(OrbitflareError.stream(`no traffic after ${rc.opts.maxMissedPongs} pings`));
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
  }, rc.opts.pingIntervalSecs * 1000);

  await done;
}

async function runSlotConnection(
  url: string,
  idx: number,
  rc: Reconnector,
  request: SubscribeSlotsRequest,
  stream: SlotStream,
): Promise<void> {
  const client = makeClient(url, rc.opts);

  let call: ClientReadableStream<SlotEvent>;
  try {
    call = client.subscribeSlots(request);
  } catch (e) {
    client.close();
    throw OrbitflareError.transport(e);
  }

  let resolveDone: () => void;
  let rejectDone: (err: OrbitflareError) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const cleanup = () => {
    stream._onAbort(undefined);
    try {
      call.cancel();
    } catch {}
    client.close();
  };

  let connected = false;
  const markConnected = () => {
    if (connected) return;
    connected = true;
    rc.onConnected(idx);
  };

  call.on('metadata', markConnected);
  call.on('data', (event: SlotEvent) => {
    markConnected();
    rc.onMessage();
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

  stream._onAbort(() => {
    resolveDone();
    cleanup();
  });
  if (rc.shouldStop) {
    resolveDone!();
    cleanup();
  }

  await done;
}

export class JetstreamClientBuilder {
  private _url?: string;
  private _fallbacks: string[] = [];
  private _apiKey?: string;
  private _retry: RetryPolicy = defaultRetryPolicy();
  private _timeoutSecs = 30;
  private _keepaliveSecs = DEFAULT_KEEPALIVE_SECS;
  private _pingIntervalSecs = DEFAULT_PING_INTERVAL_SECS;
  private _maxMissedPongs = DEFAULT_MAX_MISSED_PONGS;
  private _channelCapacity = 4096;
  private _maxDecodingMessageSize = DEFAULT_MAX_DECODING_MESSAGE_SIZE;
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

  maxDecodingMessageSize(bytes: number): this {
    this._maxDecodingMessageSize = bytes;
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
      maxDecodingMessageSize: this._maxDecodingMessageSize,
      logger: resolveLogger(this._logger, this._logLevel),
    });
  }
}
