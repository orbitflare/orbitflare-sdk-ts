import { type ClientOptions } from '@grpc/grpc-js';

import { apiKeyInterceptors } from './address.js';
import { type EndpointSet } from './endpoint.js';
import { OrbitflareError, sanitizeUrl } from './error.js';
import { type ConnectionEvent, EventHub, endpointLabel } from './events.js';
import { type Logger } from './logger.js';
import { delayForAttempt, hasAttemptsLeft, type RetryPolicy } from './retry.js';

export const DEFAULT_PING_INTERVAL_SECS = 10;
export const DEFAULT_MAX_MISSED_PONGS = 3;
export const DEFAULT_KEEPALIVE_SECS = 20;
export const DEFAULT_MAX_DECODING_MESSAGE_SIZE = 64 * 1024 * 1024;

const KEEPALIVE_TIMEOUT_MS = 10_000;
const FLOW_CONTROL_WINDOW = 5 * 1024 * 1024;

export interface StreamOptions {
  endpoints: EndpointSet;
  apiKey?: string;
  retry: RetryPolicy;
  timeoutSecs: number;
  keepaliveSecs: number;
  pingIntervalSecs: number;
  maxMissedPongs: number;
  channelCapacity: number;
  maxDecodingMessageSize: number;
  logger: Logger;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Inbox<T> {
  private buffer: T[] = [];
  private waiting: { resolve: (v: T | undefined) => void; reject: (e: unknown) => void }[] = [];
  private errored?: OrbitflareError;
  closed = false;

  next(): Promise<T | undefined> {
    if (this.buffer.length > 0) return Promise.resolve(this.buffer.shift());
    if (this.errored) {
      const err = this.errored;
      this.errored = undefined;
      return Promise.reject(err);
    }
    if (this.closed) return Promise.resolve(undefined);
    return new Promise<T | undefined>((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve(item);
    else this.buffer.push(item);
  }

  close(): boolean {
    if (this.closed) return false;
    this.closed = true;
    while (this.waiting.length > 0) this.waiting.shift()!.resolve(undefined);
    return true;
  }

  fail(err: OrbitflareError): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiting.shift();
    if (waiter) waiter.reject(err);
    else this.errored = err;
    while (this.waiting.length > 0) this.waiting.shift()!.resolve(undefined);
  }
}

export function clientOptions(opts: StreamOptions): Partial<ClientOptions> {
  return {
    interceptors: apiKeyInterceptors(opts.apiKey),
    'grpc.keepalive_time_ms': opts.keepaliveSecs * 1000,
    'grpc.keepalive_timeout_ms': KEEPALIVE_TIMEOUT_MS,
    'grpc.keepalive_permit_without_calls': 1,
    'grpc.max_receive_message_length': opts.maxDecodingMessageSize,
    'grpc-node.flow_control_window': FLOW_CONTROL_WINDOW,
  };
}

export function toGrpcError(e: any): OrbitflareError {
  const code = typeof e?.code === 'number' ? e.code : 2;
  const message = typeof e?.details === 'string' ? e.details : (e?.message ?? 'grpc error');
  return OrbitflareError.grpc(code, message);
}

export function isPermanent(err: OrbitflareError): boolean {
  return err.kind === 'grpc' && [3, 7, 12, 16].includes(err.grpc?.code ?? -1);
}

export class Reconnector {
  readonly events = new EventHub();
  private attempt = 0;
  private endpoint = '';
  private stopped = false;

  constructor(
    readonly opts: StreamOptions,
    private readonly label: string,
  ) {}

  get currentAttempt(): number {
    return this.attempt;
  }

  get shouldStop(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
  }

  emit(event: ConnectionEvent): void {
    this.events.emit(event);
  }

  pick(): { idx: number; url: string } {
    this.attempt += 1;
    const idx = this.opts.endpoints.pick();
    const url = this.opts.endpoints.get(idx);
    this.opts.logger.info(`connecting (${this.label})`, {
      endpoint: sanitizeUrl(url),
      attempt: this.attempt,
    });
    this.endpoint = endpointLabel(url);
    this.emit({ type: 'connecting', endpoint: this.endpoint, attempt: this.attempt });
    return { idx, url };
  }

  onConnected(idx: number): void {
    this.opts.endpoints.markSuccess(idx);
    this.opts.logger.info(`connected, streaming (${this.label})`);
    this.emit({ type: 'connected', endpoint: this.endpoint });
  }

  onMessage(): void {
    this.attempt = 0;
  }

  async afterError(idx: number, url: string, e: unknown): Promise<OrbitflareError | undefined> {
    this.opts.endpoints.markFailure(idx);
    const err = e instanceof OrbitflareError ? e : OrbitflareError.transport(e);
    if (isPermanent(err) || !hasAttemptsLeft(this.opts.retry, this.attempt)) {
      this.emit({ type: 'disconnected', endpoint: this.endpoint, error: err.message });
      return err.withEndpoint(url);
    }
    const delayMs = delayForAttempt(this.opts.retry, this.attempt);
    this.emit({
      type: 'disconnected',
      endpoint: this.endpoint,
      error: err.message,
      retryInMs: delayMs,
    });
    this.opts.logger.warn(`reconnecting (${this.label})`, {
      error: err,
      endpoint: sanitizeUrl(url),
      attempt: this.attempt,
      delayMs,
    });
    await sleep(delayMs);
    return undefined;
  }

  async run(
    connect: (url: string, idx: number) => Promise<void>,
    fail: (err: OrbitflareError) => void,
  ): Promise<void> {
    try {
      while (!this.stopped) {
        const { idx, url } = this.pick();
        try {
          await connect(url, idx);
          return;
        } catch (e) {
          if (this.stopped) return;
          const fatal = await this.afterError(idx, url, e);
          if (fatal) {
            fail(fatal);
            return;
          }
        }
      }
    } finally {
      this.events.end();
    }
  }
}
