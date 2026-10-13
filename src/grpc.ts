import { type ClientDuplexStream, type ClientOptions } from '@grpc/grpc-js';

import { parseAddress } from './address.js';
import { EndpointSet } from './endpoint.js';
import { OrbitflareError, sanitizeUrl } from './error.js';
import { type Logger, type LogLevel, resolveLogger } from './logger.js';
import { defaultRetryPolicy, delayForAttempt, hasAttemptsLeft, type RetryPolicy } from './retry.js';
import {
  GeyserClient as ProtoGeyserClient,
  type SubscribeRequest,
  type SubscribeRequestFilterAccounts,
  type SubscribeRequestFilterAccountsFilter,
  type SubscribeRequestFilterBlocks,
  type SubscribeRequestFilterDeshredTransactions,
  type SubscribeRequestFilterSlots,
  type SubscribeRequestFilterTransactions,
  type SubscribeUpdate,
} from './proto/geyser.js';
import { geyserConfigToRequest, loadGeyserConfig } from './config.js';
import { Commitment, Lamports, Memcmp } from './filters.js';

export { Commitment, Lamports, Memcmp } from './filters.js';
export type { LamportsCmp, MemcmpData } from './filters.js';

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
  logger: Logger;
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

    const { logger } = this.opts;
    void (async () => {
      let attempt = 0;
      while (!shutdownRequested) {
        attempt += 1;
        const idx = this.opts.endpoints.pick();
        const url = this.opts.endpoints.get(idx);
        logger.info('connecting (grpc)', { endpoint: sanitizeUrl(url), attempt });

        try {
          await runConnection(
            url,
            request,
            stream,
            this.opts,
            () => shutdownRequested,
            () => {
              attempt = 0;
              logger.info('connected, streaming (grpc)');
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
          logger.warn('reconnecting (grpc)', {
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
  stream: GeyserStream,
  opts: GeyserClientOptions,
  shouldShutdown: () => boolean,
  onConnected: () => void,
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
      logger: resolveLogger(this._logger, this._logLevel),
    });
  }
}

function memcmpToProto(m: Memcmp): SubscribeRequestFilterAccountsFilter['memcmp'] {
  const offset = BigInt(m.offset);
  if ('bytes' in m.data) return { offset, bytes: m.data.bytes };
  if ('base58' in m.data) return { offset, base58: m.data.base58 };
  return { offset, base64: m.data.base64 };
}

function lamportsToProto(l: Lamports): SubscribeRequestFilterAccountsFilter['lamports'] {
  const c = l.cmp;
  if ('eq' in c) return { eq: BigInt(c.eq) };
  if ('ne' in c) return { ne: BigInt(c.ne) };
  if ('lt' in c) return { lt: BigInt(c.lt) };
  return { gt: BigInt(c.gt) };
}

type AccountCondition =
  | { kind: 'memcmp'; memcmp: Memcmp }
  | { kind: 'datasize'; datasize: number }
  | { kind: 'tokenAccountState'; state: boolean }
  | { kind: 'lamports'; lamports: Lamports };

export class TransactionFilter {
  private _vote?: boolean;
  private _failed?: boolean;
  private _signature?: string;
  private _accountInclude: string[] = [];
  private _accountExclude: string[] = [];
  private _accountRequired: string[] = [];

  vote(vote: boolean): this {
    this._vote = vote;
    return this;
  }

  failed(failed: boolean): this {
    this._failed = failed;
    return this;
  }

  signature(signature: string): this {
    this._signature = signature;
    return this;
  }

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

  toProto(): SubscribeRequestFilterTransactions {
    return {
      vote: this._vote,
      failed: this._failed,
      signature: this._signature,
      accountInclude: this._accountInclude,
      accountExclude: this._accountExclude,
      accountRequired: this._accountRequired,
    };
  }
}

export class AccountFilter {
  private _account: string[] = [];
  private _owner: string[] = [];
  private _conditions: AccountCondition[] = [];
  private _nonemptyTxnSignature?: boolean;

  account(accounts: string[]): this {
    this._account.push(...accounts);
    return this;
  }

  owner(owners: string[]): this {
    this._owner.push(...owners);
    return this;
  }

  memcmp(memcmp: Memcmp): this {
    this._conditions.push({ kind: 'memcmp', memcmp });
    return this;
  }

  datasize(datasize: number): this {
    this._conditions.push({ kind: 'datasize', datasize });
    return this;
  }

  tokenAccountState(state: boolean): this {
    this._conditions.push({ kind: 'tokenAccountState', state });
    return this;
  }

  lamports(lamports: Lamports): this {
    this._conditions.push({ kind: 'lamports', lamports });
    return this;
  }

  nonemptyTxnSignature(value: boolean): this {
    this._nonemptyTxnSignature = value;
    return this;
  }

  toProto(): SubscribeRequestFilterAccounts {
    const filters: SubscribeRequestFilterAccountsFilter[] = this._conditions.map((c) => {
      switch (c.kind) {
        case 'memcmp':
          return { memcmp: memcmpToProto(c.memcmp) };
        case 'datasize':
          return { datasize: BigInt(c.datasize) };
        case 'tokenAccountState':
          return { tokenAccountState: c.state };
        case 'lamports':
          return { lamports: lamportsToProto(c.lamports) };
      }
    });
    return {
      account: this._account,
      owner: this._owner,
      filters,
      nonemptyTxnSignature: this._nonemptyTxnSignature,
    };
  }
}

export class SlotFilter {
  private _filterByCommitment?: boolean;
  private _interslotUpdates?: boolean;

  filterByCommitment(value: boolean): this {
    this._filterByCommitment = value;
    return this;
  }

  interslotUpdates(value: boolean): this {
    this._interslotUpdates = value;
    return this;
  }

  toProto(): SubscribeRequestFilterSlots {
    return {
      filterByCommitment: this._filterByCommitment,
      interslotUpdates: this._interslotUpdates,
    };
  }
}

export class BlockFilter {
  private _accountInclude: string[] = [];
  private _includeTransactions?: boolean;
  private _includeAccounts?: boolean;
  private _includeEntries?: boolean;

  accountInclude(accounts: string[]): this {
    this._accountInclude.push(...accounts);
    return this;
  }

  includeTransactions(value: boolean): this {
    this._includeTransactions = value;
    return this;
  }

  includeAccounts(value: boolean): this {
    this._includeAccounts = value;
    return this;
  }

  includeEntries(value: boolean): this {
    this._includeEntries = value;
    return this;
  }

  toProto(): SubscribeRequestFilterBlocks {
    return {
      accountInclude: this._accountInclude,
      includeTransactions: this._includeTransactions,
      includeAccounts: this._includeAccounts,
      includeEntries: this._includeEntries,
    };
  }
}

export class DeshredTransactionFilter {
  private _vote?: boolean;
  private _accountInclude: string[] = [];
  private _accountExclude: string[] = [];
  private _accountRequired: string[] = [];

  vote(vote: boolean): this {
    this._vote = vote;
    return this;
  }

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

  toProto(): SubscribeRequestFilterDeshredTransactions {
    return {
      vote: this._vote,
      accountInclude: this._accountInclude,
      accountExclude: this._accountExclude,
      accountRequired: this._accountRequired,
    };
  }
}

export class SubscribeRequestBuilder {
  private _accounts: Record<string, AccountFilter> = {};
  private _slots: Record<string, SlotFilter> = {};
  private _transactions: Record<string, TransactionFilter> = {};
  private _transactionsStatus: Record<string, TransactionFilter> = {};
  private _blocks: Record<string, BlockFilter> = {};
  private _blocksMeta: string[] = [];
  private _entry: string[] = [];
  private _commitment?: Commitment;
  private _accountsDataSlice: { offset: number; length: number }[] = [];
  private _fromSlot?: number;

  accounts(name: string, filter: AccountFilter): this {
    this._accounts[name] = filter;
    return this;
  }

  slots(name: string, filter: SlotFilter): this {
    this._slots[name] = filter;
    return this;
  }

  transactions(name: string, filter: TransactionFilter): this {
    this._transactions[name] = filter;
    return this;
  }

  transactionsStatus(name: string, filter: TransactionFilter): this {
    this._transactionsStatus[name] = filter;
    return this;
  }

  blocks(name: string, filter: BlockFilter): this {
    this._blocks[name] = filter;
    return this;
  }

  blocksMeta(name: string): this {
    this._blocksMeta.push(name);
    return this;
  }

  entry(name: string): this {
    this._entry.push(name);
    return this;
  }

  commitment(commitment: Commitment): this {
    this._commitment = commitment;
    return this;
  }

  accountsDataSlice(offset: number, length: number): this {
    this._accountsDataSlice.push({ offset, length });
    return this;
  }

  fromSlot(slot: number): this {
    this._fromSlot = slot;
    return this;
  }

  build(): SubscribeRequest {
    const mapValues = <T, U>(rec: Record<string, T>, fn: (v: T) => U): Record<string, U> => {
      const out: Record<string, U> = {};
      for (const [k, v] of Object.entries(rec)) out[k] = fn(v);
      return out;
    };
    return {
      accounts: mapValues(this._accounts, (f) => f.toProto()),
      slots: mapValues(this._slots, (f) => f.toProto()),
      transactions: mapValues(this._transactions, (f) => f.toProto()),
      transactionsStatus: mapValues(this._transactionsStatus, (f) => f.toProto()),
      blocks: mapValues(this._blocks, (f) => f.toProto()),
      blocksMeta: Object.fromEntries(this._blocksMeta.map((k) => [k, {}])),
      entry: Object.fromEntries(this._entry.map((k) => [k, {}])),
      commitment: this._commitment as SubscribeRequest['commitment'],
      accountsDataSlice: this._accountsDataSlice.map((s) => ({
        offset: BigInt(s.offset),
        length: BigInt(s.length),
      })),
      // No ping here: vanilla Yellowstone answers a request that carries a ping with a pong
      // and ignores its filters, so the subscription would never start.
      ping: undefined,
      fromSlot: this._fromSlot === undefined ? undefined : BigInt(this._fromSlot),
    };
  }
}
