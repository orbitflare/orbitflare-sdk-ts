import WebSocket from 'ws';

import { applyApiKey } from './credentials.js';
import { EndpointSet } from './endpoint.js';
import { OrbitflareError } from './error.js';
import { defaultRetryPolicy, delayForAttempt, hasAttemptsLeft, type RetryPolicy } from './retry.js';

const DEFAULT_PING_INTERVAL_SECS = 10;
const DEFAULT_MAX_MISSED_PONGS = 3;

interface ActiveSub {
  method: string;
  params: any;
  emit: (value: any) => void;
}

interface PendingNew {
  kind: 'new';
  method: string;
  params: any;
  emit: (value: any) => void;
  resolve: (subId: number) => void;
  reject: (err: OrbitflareError) => void;
}

interface PendingResubscribe {
  kind: 'resubscribe';
  oldSubId: number;
}

type Pending = PendingNew | PendingResubscribe;

type EventListener = (value: any) => void;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class WsSubscription {
  private listeners = new Set<EventListener>();
  private buffer: any[] = [];
  private waiting: ((v: any) => void)[] = [];
  private closed = false;

  constructor(
    public readonly subId: number,
    private readonly unsubMethod: string,
    private readonly client: WsClient,
  ) {}

  async next(): Promise<any | undefined> {
    if (this.buffer.length > 0) return this.buffer.shift();
    if (this.closed) return undefined;
    return new Promise<any>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _push(value: any): void {
    for (const l of this.listeners) {
      try {
        l(value);
      } catch {}
    }
    if (this.waiting.length > 0) {
      this.waiting.shift()!(value);
    } else {
      this.buffer.push(value);
    }
  }

  _close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()!(undefined);
    }
  }

  async unsubscribe(): Promise<void> {
    this._close();
    await this.client._unsubscribe(this.subId, this.unsubMethod);
  }
}

export interface WsClientBuildOptions {
  url?: string;
  fallbacks?: string[];
  apiKey?: string;
  retry?: RetryPolicy;
  pingIntervalSecs?: number;
  maxMissedPongs?: number;
}

export class WsClientBuilder {
  private _url?: string;
  private _fallbacks: string[] = [];
  private _apiKey?: string;
  private _retry: RetryPolicy = defaultRetryPolicy();
  private _pingIntervalSecs = DEFAULT_PING_INTERVAL_SECS;
  private _maxMissedPongs = DEFAULT_MAX_MISSED_PONGS;

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

  apiKey(key: string): this {
    this._apiKey = key;
    return this;
  }

  retry(policy: RetryPolicy): this {
    this._retry = policy;
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

  async build(): Promise<WsClient> {
    const url = this._url ?? process.env.ORBITFLARE_WS_URL;
    if (!url) {
      throw OrbitflareError.config(
        'no WebSocket URL provided. Pass .url() to the builder or set ORBITFLARE_WS_URL in your environment',
      );
    }

    const apiKey = this._apiKey ?? process.env.ORBITFLARE_LICENSE_KEY ?? undefined;
    const apply = (u: string) => (apiKey ? applyApiKey(u, apiKey) : u);
    const authedUrls = [apply(url), ...this._fallbacks.map(apply)];
    const endpoints = new EndpointSet(authedUrls[0]!, authedUrls.slice(1));

    const client = new WsClient({
      endpoints,
      retry: this._retry,
      pingIntervalSecs: this._pingIntervalSecs,
      maxMissedPongs: this._maxMissedPongs,
    });
    await client._start();
    return client;
  }
}

export class WsClient {
  private readonly endpoints: EndpointSet;
  private readonly retry: RetryPolicy;
  private readonly pingIntervalMs: number;
  private readonly maxMissedPongs: number;

  private ws?: WebSocket;
  private nextReqId = 1;
  private subs = new Map<number, ActiveSub>();
  private subscriptions = new Map<number, WsSubscription>();
  private pending = new Map<number, Pending>();
  private pingTimer?: NodeJS.Timeout;
  private missedPongs = 0;
  private shutdownRequested = false;
  private reconnectAttempt = 0;

  constructor(opts: {
    endpoints: EndpointSet;
    retry: RetryPolicy;
    pingIntervalSecs: number;
    maxMissedPongs: number;
  }) {
    this.endpoints = opts.endpoints;
    this.retry = opts.retry;
    this.pingIntervalMs = opts.pingIntervalSecs * 1000;
    this.maxMissedPongs = opts.maxMissedPongs;
  }

  async _start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    for (let i = 0; i < this.endpoints.length; i++) {
      const url = this.endpoints.get(i);
      try {
        const ws = await openSocket(url);
        this.ws = ws;
        this.endpoints.markSuccess(i);
        this.attachHandlers(ws, i);
        this.startPingTimer();
        this.replaySubscriptions();
        this.reconnectAttempt = 0;
        return;
      } catch {
        this.endpoints.markFailure(i);
      }
    }
    throw OrbitflareError.transport(new Error('all ws endpoints failed'));
  }

  private attachHandlers(ws: WebSocket, endpointIdx: number): void {
    ws.on('message', (raw) => {
      this.missedPongs = 0;
      let parsed: any;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleMessage(parsed);
    });
    ws.on('pong', () => {
      this.missedPongs = 0;
    });
    ws.on('close', () => {
      if (this.shutdownRequested) return;
      this.endpoints.markFailure(endpointIdx);
      void this.scheduleReconnect();
    });
    ws.on('error', () => {});
  }

  private startPingTimer(): void {
    this.stopPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.missedPongs >= this.maxMissedPongs) {
        try {
          this.ws?.terminate();
        } catch {}
        return;
      }
      try {
        this.ws?.ping();
        this.missedPongs += 1;
      } catch {}
    }, this.pingIntervalMs);
  }

  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private async scheduleReconnect(): Promise<void> {
    this.stopPingTimer();
    this.ws = undefined;

    while (!this.shutdownRequested) {
      this.reconnectAttempt += 1;
      if (!hasAttemptsLeft(this.retry, this.reconnectAttempt)) {
        for (const sub of this.subscriptions.values()) sub._close();
        return;
      }
      await sleep(delayForAttempt(this.retry, this.reconnectAttempt));
      try {
        await this.connect();
        return;
      } catch {}
    }
  }

  private replaySubscriptions(): void {
    if (!this.ws) return;
    const previous = Array.from(this.subs.entries());
    this.subs.clear();
    for (const [oldSubId, sub] of previous) {
      const id = this.nextReqId++;
      const msg = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: sub.method,
        params: sub.params,
      });
      this.pending.set(id, { kind: 'resubscribe', oldSubId });
      this.subs.set(oldSubId, sub);
      try {
        this.ws.send(msg);
      } catch {}
    }
  }

  private handleMessage(msg: any): void {
    if (typeof msg?.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);

      if (pending.kind === 'new') {
        if (msg.error) {
          const code = typeof msg.error.code === 'number' ? msg.error.code : 0;
          const message =
            typeof msg.error.message === 'string' ? msg.error.message : 'subscribe failed';
          pending.reject(OrbitflareError.rpc(code, message));
          return;
        }
        const subId = msg.result;
        if (typeof subId !== 'number') {
          pending.reject(OrbitflareError.rpc(0, 'missing subscription id in response'));
          return;
        }
        this.subs.set(subId, {
          method: pending.method,
          params: pending.params,
          emit: pending.emit,
        });
        pending.resolve(subId);
      } else {
        const newSubId = msg.result;
        if (typeof newSubId !== 'number') return;
        const sub = this.subs.get(pending.oldSubId);
        if (!sub) return;
        this.subs.delete(pending.oldSubId);
        this.subs.set(newSubId, sub);
        const handle = this.subscriptions.get(pending.oldSubId);
        if (handle) {
          this.subscriptions.delete(pending.oldSubId);
          this.subscriptions.set(newSubId, handle);
        }
      }
      return;
    }

    const params = msg?.params;
    if (!params) return;
    const subId = params.subscription;
    if (typeof subId !== 'number') return;

    const sub = this.subs.get(subId);
    if (!sub) {
      this.autoUnsubscribe(subId, msg);
      return;
    }
    const result = params.result;
    if (result === undefined) return;
    const payload =
      result && typeof result === 'object' && 'context' in result && 'value' in result
        ? result.value
        : result;
    sub.emit(payload);
  }

  private autoUnsubscribe(subId: number, msg: any): void {
    const method = typeof msg?.method === 'string' ? msg.method : undefined;
    if (!method) return;
    const op = method.endsWith('Notification')
      ? method.slice(0, -'Notification'.length)
      : undefined;
    if (!op) return;
    const unsubMethod = `${op}Unsubscribe`;
    try {
      this.ws?.send(
        JSON.stringify({ jsonrpc: '2.0', id: 0, method: unsubMethod, params: [subId] }),
      );
    } catch {}
  }

  async accountSubscribe(address: string, commitment: string): Promise<WsSubscription> {
    return this.subscribeInner('accountSubscribe', 'accountUnsubscribe', [
      address,
      { encoding: 'base64', commitment },
    ]);
  }

  async logsSubscribe(mentions: string[], commitment: string): Promise<WsSubscription> {
    const filter = mentions.length === 0 ? 'all' : { mentions };
    return this.subscribeInner('logsSubscribe', 'logsUnsubscribe', [filter, { commitment }]);
  }

  async slotSubscribe(): Promise<WsSubscription> {
    return this.subscribeInner('slotSubscribe', 'slotUnsubscribe', []);
  }

  async signatureSubscribe(signature: string, commitment: string): Promise<WsSubscription> {
    return this.subscribeInner('signatureSubscribe', 'signatureUnsubscribe', [
      signature,
      { commitment },
    ]);
  }

  private subscribeInner(
    method: string,
    unsubMethod: string,
    params: any,
  ): Promise<WsSubscription> {
    if (!this.ws) {
      return Promise.reject(OrbitflareError.stream('ws not connected'));
    }
    const id = this.nextReqId++;
    return new Promise<WsSubscription>((resolve, reject) => {
      const sub: { handle?: WsSubscription } = {};
      const emit = (value: any) => sub.handle?._push(value);

      this.pending.set(id, {
        kind: 'new',
        method,
        params,
        emit,
        resolve: (subId: number) => {
          const handle = new WsSubscription(subId, unsubMethod, this);
          sub.handle = handle;
          this.subscriptions.set(subId, handle);
          resolve(handle);
        },
        reject,
      });

      try {
        this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch {
        this.pending.delete(id);
        reject(OrbitflareError.stream('ws send failed'));
      }
    });
  }

  async _unsubscribe(subId: number, method: string): Promise<void> {
    this.subs.delete(subId);
    this.subscriptions.delete(subId);
    if (!this.ws) return;
    try {
      const id = this.nextReqId++;
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: [subId] }));
    } catch {}
  }

  async close(): Promise<void> {
    this.shutdownRequested = true;
    this.stopPingTimer();
    for (const sub of this.subscriptions.values()) sub._close();
    try {
      this.ws?.close();
    } catch {}
  }
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    const onOpen = () => {
      ws.off('error', onError);
      resolve(ws);
    };
    const onError = (e: Error) => {
      ws.off('open', onOpen);
      reject(OrbitflareError.transport(e));
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}
