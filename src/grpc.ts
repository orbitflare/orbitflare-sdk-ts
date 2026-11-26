import { type ClientDuplexStream, Metadata, type ServiceError } from '@grpc/grpc-js';

import { parseAddress } from './address.js';
import { EndpointSet } from './endpoint.js';
import { OrbitflareError } from './error.js';
import { type ConnectionEvents, endpointLabel } from './events.js';
import { type Logger, type LogLevel, resolveLogger } from './logger.js';
import { defaultRetryPolicy, type RetryPolicy } from './retry.js';
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
} from './streaming.js';
import {
  GeyserClient as ProtoGeyserClient,
  type SubscribeRequest,
  type SubscribeRequestFilterAccounts,
  type SubscribeRequestFilterAccountsFilter,
  type SubscribeRequestFilterBlockFooter,
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
export { ConnectionEvents, type ConnectionEvent } from './events.js';

const REPLAY_INFO_TIMEOUT_MS = 10_000;

export interface ConnectInfo {
  endpoint: string;
  attempt: number;
  reconnect: boolean;
  lastSlot?: bigint;
}

type RequestSource =
  | { kind: 'fixed'; request: SubscribeRequest }
  | { kind: 'build'; build: (info: ConnectInfo) => SubscribeRequest };

export class GeyserHandle {
  constructor(private readonly stream: GeyserStream) {}

  update(request: SubscribeRequest): void {
    this.stream.update(request);
  }
}

export class GeyserStream {
  private inbox = new Inbox<SubscribeUpdate>();
  private call?: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
  private pending: SubscribeRequest[] = [];
  private abort?: () => void;
  _connectedBefore = false;
  _lastSlot?: bigint;

  constructor(
    private readonly rc: Reconnector,
    private source: RequestSource,
  ) {}

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

  handle(): GeyserHandle {
    return new GeyserHandle(this);
  }

  update(request: SubscribeRequest): void {
    if (this.inbox.closed) throw OrbitflareError.stream('stream closed');
    const update: SubscribeRequest = { ...request, fromSlot: undefined };
    if (this.source.kind === 'fixed') this.source = { kind: 'fixed', request: update };
    if (this.call) {
      try {
        this.call.write(update);
      } catch {}
    } else {
      this.pending.push(update);
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

  _request(info: ConnectInfo): SubscribeRequest {
    this.pending = [];
    return this.source.kind === 'fixed' ? this.source.request : this.source.build(info);
  }

  _attach(
    call: ClientDuplexStream<SubscribeRequest, SubscribeUpdate> | undefined,
    abort?: () => void,
  ): void {
    this.call = call;
    this.abort = abort;
    if (!call) return;
    const pending = this.pending;
    this.pending = [];
    for (const update of pending) call.write(update);
  }

  _push(update: SubscribeUpdate): void {
    this.inbox.push(update);
  }

  _fail(err: OrbitflareError): void {
    this.inbox.fail(err);
  }
}

export class GeyserClient {
  constructor(private readonly opts: StreamOptions) {}

  subscribeYaml(path: string): GeyserStream {
    const cfg = loadGeyserConfig(path);
    return this.subscribe(geyserConfigToRequest(cfg));
  }

  subscribe(request: SubscribeRequest): GeyserStream {
    return this.spawn({ kind: 'fixed', request });
  }

  subscribeWith(build: (info: ConnectInfo) => SubscribeRequest): GeyserStream {
    return this.spawn({ kind: 'build', build });
  }

  private spawn(source: RequestSource): GeyserStream {
    const rc = new Reconnector(this.opts, 'grpc');
    const stream = new GeyserStream(rc, source);
    void rc.run(
      (url, idx) => runConnection(url, idx, rc, stream),
      (err) => stream._fail(err),
    );
    return stream;
  }
}

function slotOf(update: SubscribeUpdate): bigint | undefined {
  return (
    update.slot?.slot ??
    update.transaction?.slot ??
    update.transactionStatus?.slot ??
    update.account?.slot ??
    update.block?.slot ??
    update.blockMeta?.slot ??
    update.entry?.slot
  );
}

async function replayFrom(
  client: ProtoGeyserClient,
  rc: Reconnector,
  wanted: bigint,
): Promise<bigint | undefined> {
  const answer = await new Promise<{ firstAvailable?: bigint } | ServiceError>((resolve) => {
    client.subscribeReplayInfo(
      {},
      new Metadata(),
      { deadline: Date.now() + REPLAY_INFO_TIMEOUT_MS },
      (err, resp) => resolve(err ?? resp),
    );
  });
  if (answer instanceof Error) {
    rc.opts.logger.debug('replay window lookup failed; using fromSlot as is', {
      error: answer.message,
    });
    return wanted;
  }
  const available = answer.firstAvailable;
  if (available === undefined) {
    rc.opts.logger.warn('endpoint does not support replay; starting live', { requested: wanted });
    rc.emit({ type: 'replayUnavailable', requested: wanted });
    return undefined;
  }
  if (wanted < available) {
    rc.opts.logger.warn(
      'fromSlot is older than the replay window; starting at the oldest available slot',
      { requested: wanted, available },
    );
    rc.emit({ type: 'replayClamped', requested: wanted, available });
    return available;
  }
  return wanted;
}

function pingRequest(id: number): SubscribeRequest {
  return {
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    commitment: undefined,
    accountsDataSlice: [],
    ping: { id },
    fromSlot: undefined,
    blockFooter: {},
  };
}

async function runConnection(
  url: string,
  idx: number,
  rc: Reconnector,
  stream: GeyserStream,
): Promise<void> {
  const { target, credentials } = parseAddress(url);
  const client = new ProtoGeyserClient(target, credentials, clientOptions(rc.opts));

  let request: SubscribeRequest;
  try {
    request = stream._request({
      endpoint: endpointLabel(url),
      attempt: rc.currentAttempt,
      reconnect: stream._connectedBefore,
      lastSlot: stream._lastSlot,
    });
    if (request.fromSlot !== undefined) {
      request = { ...request, fromSlot: await replayFrom(client, rc, request.fromSlot) };
    }
  } catch (e) {
    client.close();
    throw e;
  }
  if (rc.shouldStop) {
    client.close();
    return;
  }

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
    stream._connectedBefore = true;
  };

  call.on('metadata', markConnected);
  call.on('data', (update: SubscribeUpdate) => {
    markConnected();
    missedPongs = 0;
    rc.onMessage();
    if (update.pong) return;
    const slot = slotOf(update);
    if (slot !== undefined && (stream._lastSlot === undefined || slot > stream._lastSlot)) {
      stream._lastSlot = slot;
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
    stream._attach(call, () => {
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
      call.write(pingRequest(pingId));
      pingId += 1;
      missedPongs += 1;
    } catch {
      cleanup();
      rejectDone(OrbitflareError.stream('outbound closed'));
    }
  }, rc.opts.pingIntervalSecs * 1000);

  await done;
}

export class GeyserClientBuilder {
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

  build(): GeyserClient {
    const url = this._url ?? process.env.ORBITFLARE_GRPC_URL;
    if (!url) {
      throw OrbitflareError.config(
        'no gRPC URL provided. Pass .url() to the builder or set ORBITFLARE_GRPC_URL in your environment',
      );
    }
    return new GeyserClient({
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

export class BlockFooterFilter {
  private _includeCertificates?: boolean;

  includeCertificates(value: boolean): this {
    this._includeCertificates = value;
    return this;
  }

  toProto(): SubscribeRequestFilterBlockFooter {
    return { includeCertificates: this._includeCertificates };
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
  private _blockFooter: Record<string, BlockFooterFilter> = {};
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

  blockFooter(name: string, filter: BlockFooterFilter): this {
    this._blockFooter[name] = filter;
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
      blockFooter: mapValues(this._blockFooter, (f) => f.toProto()),
    };
  }
}
