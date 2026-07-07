import { type ClientDuplexStream, type ClientOptions } from '@grpc/grpc-js';

import { parseAddress } from '../address.js';
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
  JetstreamClient as ProtoJetstreamClient,
  type SubscribeRequest,
  type SubscribeUpdate,
} from '../proto/jetstream.js';
import { jetstreamConfigToRequest, loadJetstreamConfig } from '../config.js';

export { TransactionFilter, SubscribeRequestBuilder } from './filters.js';

const DEFAULT_PING_INTERVAL_SECS = 10;
const DEFAULT_MAX_MISSED_PONGS = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class JetstreamStream {
  private buffer: SubscribeUpdate[] = [];
  private waiting: ((v: SubscribeUpdate | undefined) => void)[] = [];
  private errored?: OrbitflareError;
  private closed = false;

  constructor(private readonly onClose: () => void) {}

  async next(): Promise<SubscribeUpdate | undefined> {
    if (this.buffer.length > 0) return this.buffer.shift();
    if (this.errored) throw this.errored;
    if (this.closed) return undefined;
    return new Promise<SubscribeUpdate | undefined>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<SubscribeUpdate> {
    while (true) {
      const v = await this.next();
      if (v === undefined) return;
      yield v;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    while (this.waiting.length > 0) this.waiting.shift()!(undefined);
  }

  _push(update: SubscribeUpdate): void {
    if (this.closed) return;
    if (this.waiting.length > 0) {
      this.waiting.shift()!(update);
    } else {
      this.buffer.push(update);
    }
  }

  _fail(err: OrbitflareError): void {
    if (this.closed) return;
    this.errored = err;
    this.closed = true;
    this.onClose();
    while (this.waiting.length > 0) this.waiting.shift()!(undefined);
  }
}

interface JetstreamClientOptions {
  endpoints: EndpointSet;
  retry: RetryPolicy;
  timeoutSecs: number;
  keepaliveSecs: number;
  pingIntervalSecs: number;
  maxMissedPongs: number;
  channelCapacity: number;
  logger: Logger;
}

export class JetstreamClient {
  constructor(private readonly opts: JetstreamClientOptions) {}

  subscribeYaml(path: string): JetstreamStream {
    const cfg = loadJetstreamConfig(path);
    return this.subscribe(jetstreamConfigToRequest(cfg));
  }

  subscribe(request: SubscribeRequest): JetstreamStream {
    let shutdownRequested = false;
    const stream = new JetstreamStream(() => {
      shutdownRequested = true;
    });

    const { logger } = this.opts;
    void (async () => {
      let attempt = 0;
      while (!shutdownRequested) {
        attempt += 1;
        const idx = this.opts.endpoints.pick();
        const url = this.opts.endpoints.get(idx);
        logger.info('connecting (jetstream)', { endpoint: sanitizeUrl(url), attempt });

        try {
          await runConnection(
            url,
            request,
            stream,
            this.opts,
            () => shutdownRequested,
            () => {
              attempt = 0;
              logger.info('connected, streaming (jetstream)');
            },
          );
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
          logger.warn('reconnecting (jetstream)', {
            error: err,
            endpoint: sanitizeUrl(url),
            attempt,
            delayMs,
          });
          await sleep(delayMs);
        }
      }
    })();

    return stream;
  }
}

async function runConnection(
  url: string,
  request: SubscribeRequest,
  stream: JetstreamStream,
  opts: JetstreamClientOptions,
  shouldShutdown: () => boolean,
  onConnected: () => void,
): Promise<void> {
  const { target, credentials } = parseAddress(url);
  const clientOpts: Partial<ClientOptions> = {
    'grpc.keepalive_time_ms': opts.keepaliveSecs * 1000,
    'grpc.keepalive_timeout_ms': opts.timeoutSecs * 1000,
    'grpc.keepalive_permit_without_calls': 1,
  };
  const client = new ProtoJetstreamClient(target, credentials, clientOpts);

  let call: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
  try {
    call = client.subscribe();
  } catch (e) {
    client.close();
    throw OrbitflareError.transport(e);
  }

  let missedPongs = 0;
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
    try {
      call.end();
    } catch {}
    client.close();
  };

  call.on('data', (update: SubscribeUpdate) => {
    if (!connected) {
      connected = true;
      onConnected();
    }
    if (update.pong) {
      missedPongs = 0;
      return;
    }
    stream._push(update);
  });
  call.on('error', (e) => {
    cleanup();
    rejectDone(toGrpcError(e));
  });
  call.on('end', () => {
    cleanup();
    rejectDone(OrbitflareError.stream('stream ended'));
  });

  try {
    call.write(request);
  } catch (e) {
    cleanup();
    throw OrbitflareError.transport(e);
  }

  pingTimer = setInterval(() => {
    if (shouldShutdown()) {
      cleanup();
      resolveDone();
      return;
    }
    if (missedPongs >= opts.maxMissedPongs) {
      cleanup();
      rejectDone(OrbitflareError.stream(`no pong after ${opts.maxMissedPongs} pings`));
      return;
    }
    try {
      call.write({
        transactions: {},
        accounts: {},
        ping: { id: pingId },
      } as SubscribeRequest);
      pingId += 1;
      missedPongs += 1;
    } catch {
      cleanup();
      rejectDone(OrbitflareError.stream('outbound closed'));
    }
  }, opts.pingIntervalSecs * 1000);

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
