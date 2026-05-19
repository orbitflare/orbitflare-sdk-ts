import { type ClientDuplexStream, type ClientOptions } from '@grpc/grpc-js';

import { parseAddress } from './address.js';
import { EndpointSet } from './endpoint.js';
import { OrbitflareError } from './error.js';
import { defaultRetryPolicy, delayForAttempt, hasAttemptsLeft, type RetryPolicy } from './retry.js';
import {
  GeyserClient as ProtoGeyserClient,
  type SubscribeRequest,
  type SubscribeUpdate,
} from './proto/geyser.js';
import { geyserConfigToRequest, loadGeyserConfig } from './config.js';

const DEFAULT_PING_INTERVAL_SECS = 10;
const DEFAULT_MAX_MISSED_PONGS = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GeyserStream {
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

interface GeyserClientOptions {
  endpoints: EndpointSet;
  retry: RetryPolicy;
  timeoutSecs: number;
  keepaliveSecs: number;
  pingIntervalSecs: number;
  maxMissedPongs: number;
  channelCapacity: number;
}

export class GeyserClient {
  constructor(private readonly opts: GeyserClientOptions) {}

  subscribeYaml(path: string): GeyserStream {
    const cfg = loadGeyserConfig(path);
    return this.subscribe(geyserConfigToRequest(cfg));
  }

  subscribe(request: SubscribeRequest): GeyserStream {
    const stream = new GeyserStream(() => {
      shutdownRequested = true;
    });
    let shutdownRequested = false;

    void (async () => {
      let attempt = 0;
      while (!shutdownRequested) {
        attempt += 1;
        const idx = this.opts.endpoints.pick();
        const url = this.opts.endpoints.get(idx);

        try {
          await runConnection(url, request, stream, this.opts, () => shutdownRequested);
          this.opts.endpoints.markSuccess(idx);
          return;
        } catch (e) {
          this.opts.endpoints.markFailure(idx);
          const err = e instanceof OrbitflareError ? e : OrbitflareError.transport(e);
          if (!hasAttemptsLeft(this.opts.retry, attempt)) {
            stream._fail(err.withEndpoint(url));
            return;
          }
          await sleep(delayForAttempt(this.opts.retry, attempt));
        }
      }
    })();

    return stream;
  }
}

async function runConnection(
  url: string,
  request: SubscribeRequest,
  stream: GeyserStream,
  opts: GeyserClientOptions,
  shouldShutdown: () => boolean,
): Promise<void> {
  const { target, credentials } = parseAddress(url);
  const clientOpts: Partial<ClientOptions> = {
    'grpc.keepalive_time_ms': opts.keepaliveSecs * 1000,
    'grpc.keepalive_timeout_ms': opts.timeoutSecs * 1000,
    'grpc.keepalive_permit_without_calls': 1,
  };
  const client = new ProtoGeyserClient(target, credentials, clientOpts);

  let call: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
  try {
    call = client.subscribe();
  } catch (e) {
    client.close();
    throw OrbitflareError.transport(e);
  }

  let missedPongs = 0;
  let pingId = 1;
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
        accounts: {},
        slots: {},
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        commitment: undefined,
        accountsDataSlice: [],
        ping: { id: pingId },
        fromSlot: undefined,
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

export class GeyserClientBuilder {
  private _url?: string;
  private _fallbacks: string[] = [];
  private _retry: RetryPolicy = defaultRetryPolicy();
  private _timeoutSecs = 30;
  private _keepaliveSecs = 60;
  private _pingIntervalSecs = DEFAULT_PING_INTERVAL_SECS;
  private _maxMissedPongs = DEFAULT_MAX_MISSED_PONGS;
  private _channelCapacity = 4096;

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

  build(): GeyserClient {
    const url = this._url ?? process.env.ORBITFLARE_GRPC_URL;
    if (!url) {
      throw OrbitflareError.config(
        'no gRPC URL provided. Pass .url() to the builder or set ORBITFLARE_GRPC_URL in your environment',
      );
    }
    return new GeyserClient({
      endpoints: new EndpointSet(url, this._fallbacks),
      retry: this._retry,
      timeoutSecs: this._timeoutSecs,
      keepaliveSecs: this._keepaliveSecs,
      pingIntervalSecs: this._pingIntervalSecs,
      maxMissedPongs: this._maxMissedPongs,
      channelCapacity: this._channelCapacity,
    });
  }
}
