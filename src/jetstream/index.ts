import { type ClientDuplexStream } from '@grpc/grpc-js';

import { parseAddress } from '../address.js';
import { EndpointSet } from '../endpoint.js';
import { OrbitflareError } from '../error.js';
import { type ConnectionEvents } from '../events.js';
import { type Logger, type LogLevel, resolveLogger } from '../logger.js';
import { defaultRetryPolicy, type RetryPolicy } from '../retry.js';
import {
  clientOptions,
  DEFAULT_KEEPALIVE_SECS,
  DEFAULT_MAX_DECODING_MESSAGE_SIZE,
  DEFAULT_MAX_MISSED_PONGS,
  DEFAULT_PING_INTERVAL_SECS,
  Inbox,
  Reconnector,
  type StreamOptions,
  toGrpcError,
} from '../streaming.js';
import {
  JetstreamClient as ProtoJetstreamClient,
  type SubscribeRequest,
  type SubscribeUpdate,
} from '../proto/jetstream.js';
import { jetstreamConfigToRequest, loadJetstreamConfig } from '../config.js';

export { TransactionFilter, SubscribeRequestBuilder } from './filters.js';
export { ConnectionEvents, type ConnectionEvent } from '../events.js';

export class JetstreamStream {
  private inbox = new Inbox<SubscribeUpdate>();
  private abort?: () => void;

  constructor(private readonly rc: Reconnector) {}

  next(): Promise<SubscribeUpdate | undefined> {
    return this.inbox.next();
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<SubscribeUpdate> {
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

  _push(update: SubscribeUpdate): void {
    this.inbox.push(update);
  }

  _fail(err: OrbitflareError): void {
    this.inbox.fail(err);
  }
}

export class JetstreamClient {
  constructor(private readonly opts: StreamOptions) {}

  subscribeYaml(path: string): JetstreamStream {
    const cfg = loadJetstreamConfig(path);
    return this.subscribe(jetstreamConfigToRequest(cfg));
  }

  subscribe(request: SubscribeRequest): JetstreamStream {
    const rc = new Reconnector(this.opts, 'jetstream');
    const stream = new JetstreamStream(rc);
    void rc.run(
      (url, idx) => runConnection(url, idx, rc, request, stream),
      (err) => stream._fail(err),
    );
    return stream;
  }
}

async function runConnection(
  url: string,
  idx: number,
  rc: Reconnector,
  request: SubscribeRequest,
  stream: JetstreamStream,
): Promise<void> {
  const { target, credentials } = parseAddress(url);
  const client = new ProtoJetstreamClient(target, credentials, clientOptions(rc.opts));

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
    stream._onAbort(undefined);
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
  call.on('data', (update: SubscribeUpdate) => {
    markConnected();
    missedPongs = 0;
    rc.onMessage();
    if (update.pong) return;
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
    stream._onAbort(() => {
      resolveDone();
      cleanup();
    });
  } catch (e) {
    cleanup();
    throw OrbitflareError.transport(e);
  }
  if (rc.shouldStop) {
    resolveDone!();
    cleanup();
  }

  pingTimer = setInterval(() => {
    if (rc.shouldStop) {
      resolveDone();
      cleanup();
      return;
    }
    if (missedPongs >= rc.opts.maxMissedPongs) {
      cleanup();
      rejectDone(OrbitflareError.stream(`no pong after ${rc.opts.maxMissedPongs} pings`));
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
  }, rc.opts.pingIntervalSecs * 1000);

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
