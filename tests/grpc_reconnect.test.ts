import * as grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';

import { type ConnectionEvent, type ConnectionEvents } from '../src/events.js';
import { type ConnectInfo, GeyserClientBuilder } from '../src/grpc.js';
import {
  GeyserService,
  SubscribeRequest,
  SubscribeUpdate,
  type SubscribeReplayInfoResponse,
} from '../src/proto/geyser.js';
import { type RetryPolicy } from '../src/retry.js';

interface State {
  requests: [number, SubscribeRequest][];
  connections: number;
  nextSlot: bigint;
  dropAfter: number;
  replay?: { firstAvailable?: bigint };
  reject?: grpc.status;
}

const servers: grpc.Server[] = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()!.forceShutdown();
});

function newState(init: Partial<State> = {}): State {
  return { requests: [], connections: 0, nextSlot: 0n, dropAfter: 0, ...init };
}

const subscriptions = (state: State) => state.requests.filter(([, r]) => r.ping === undefined);

async function serve(state: State): Promise<string> {
  const server = new grpc.Server();
  server.addService(GeyserService, {
    subscribe: (call: grpc.ServerDuplexStream<SubscribeRequest, SubscribeUpdate>) => {
      state.connections += 1;
      const connection = state.connections;
      call.sendMetadata(new grpc.Metadata());
      let sent = 0;
      let ticker: NodeJS.Timeout | undefined;
      const stop = () => {
        if (ticker) clearInterval(ticker);
        ticker = undefined;
      };
      call.on('cancelled', stop);
      call.on('end', stop);
      call.on('error', stop);
      call.on('data', (req: SubscribeRequest) => {
        state.requests.push([connection, req]);
        if (req.ping) {
          call.write(SubscribeUpdate.fromPartial({ pong: { id: req.ping.id } }));
        }
        if (state.reject !== undefined) {
          stop();
          call.emit('error', { code: state.reject, details: 'mock reject' });
          return;
        }
        if (req.ping || ticker) return;
        ticker = setInterval(() => {
          if (state.dropAfter > 0 && sent >= state.dropAfter) {
            stop();
            call.emit('error', { code: grpc.status.UNAVAILABLE, details: 'mock drop' });
            return;
          }
          const slot = state.nextSlot;
          state.nextSlot += 1n;
          call.write(SubscribeUpdate.fromPartial({ slot: { slot } }));
          sent += 1;
        }, 10);
      });
    },
    subscribeReplayInfo: (
      _call: unknown,
      cb: (e: grpc.ServiceError | null, r?: SubscribeReplayInfoResponse) => void,
    ) => {
      if (state.replay === undefined) {
        cb({ code: grpc.status.UNIMPLEMENTED, details: 'no replay info' } as grpc.ServiceError);
      } else {
        cb(null, state.replay);
      }
    },
  } as never);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  servers.push(server);
  return `http://127.0.0.1:${port}`;
}

const retry = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
  initialDelayMs: 20,
  maxDelayMs: 50,
  multiplier: 2,
  maxAttempts: 0,
  ...overrides,
});

const client = (url: string, policy = retry()) =>
  new GeyserClientBuilder().url(url).retry(policy).build();

const named = (filter: string, fromSlot?: bigint): SubscribeRequest =>
  SubscribeRequest.fromPartial({ transactions: { [filter]: {} }, fromSlot });

const filterOf = (request: SubscribeRequest) => Object.keys(request.transactions)[0] ?? '';

function slotOf(update: SubscribeUpdate | undefined): bigint {
  if (!update?.slot) throw new Error(`expected a slot update, got ${JSON.stringify(update)}`);
  return update.slot.slot;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drain(events: ConnectionEvents): Promise<ConnectionEvent[]> {
  await sleep(200);
  const out: ConnectionEvent[] = [];
  for (let e = events.tryRecv(); e !== undefined; e = events.tryRecv()) out.push(e);
  return out;
}

async function eventually(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('gRPC reconnects', () => {
  it('rebuild the request and resume after the last slot', async () => {
    const state = newState({ nextSlot: 1000n, dropAfter: 5, replay: { firstAvailable: 0n } });
    const url = await serve(state);
    const infos: ConnectInfo[] = [];
    const stream = client(url).subscribeWith((info) => {
      infos.push(info);
      return named('resume', info.lastSlot === undefined ? undefined : info.lastSlot + 1n);
    });
    const events = stream.events();

    const slots: bigint[] = [];
    while (slots.length < 15) slots.push(slotOf(await stream.next()));
    expect(slots).toEqual(Array.from({ length: 15 }, (_, i) => 1000n + BigInt(i)));

    expect(infos.length).toBeGreaterThanOrEqual(3);
    expect(infos[0]).toMatchObject({ reconnect: false, lastSlot: undefined });
    expect(infos[1]).toMatchObject({ reconnect: true, lastSlot: 1004n });
    expect(infos[2]!.lastSlot).toBe(1009n);

    const subs = subscriptions(state);
    expect(subs[0]![1].fromSlot).toBeUndefined();
    expect([subs[1]![0], subs[1]![1].fromSlot]).toEqual([2, 1005n]);
    expect([subs[2]![0], subs[2]![1].fromSlot]).toEqual([3, 1010n]);

    const seen = await drain(events);
    expect(seen.slice(0, 7).map((e) => e.type)).toEqual([
      'connecting',
      'connected',
      'disconnected',
      'connecting',
      'connected',
      'disconnected',
      'connecting',
    ]);
    const dropped = seen[2]!;
    expect(dropped.type === 'disconnected' && dropped.endpoint).toBe(url);
    expect(dropped.type === 'disconnected' && dropped.error).toContain('mock drop');
    expect(dropped.type === 'disconnected' && dropped.retryInMs).toBeGreaterThan(0);
    stream.close();
  });

  it('apply updates in place and keep them after a reconnect', async () => {
    const state = newState();
    const url = await serve(state);
    const stream = client(url).subscribe(named('first'));
    await stream.next();

    stream.handle().update(named('second', 7n));
    await eventually('the update', () => subscriptions(state).length === 2);
    const subs = subscriptions(state);
    expect(state.connections).toBe(1);
    expect([subs[1]![0], filterOf(subs[1]![1]), subs[1]![1].fromSlot]).toEqual([
      1,
      'second',
      undefined,
    ]);

    state.dropAfter = 1;
    await eventually('a reconnect', () => state.connections >= 2);
    await eventually('the resubscription', () => subscriptions(state).some(([c]) => c === 2));
    const resubscribed = subscriptions(state).find(([c]) => c === 2)![1];
    expect(filterOf(resubscribed)).toBe('second');
    expect(resubscribed.fromSlot).toBeUndefined();
    stream.close();
  });

  it('apply updates sent while disconnected on the next connection', async () => {
    const state = newState({ dropAfter: 1 });
    const url = await serve(state);
    const stream = client(url, retry({ initialDelayMs: 300, maxDelayMs: 300 })).subscribe(
      named('first'),
    );
    const events = stream.events();
    for (;;) {
      const e = await events.recv();
      if (e?.type === 'disconnected') break;
    }
    stream.update(named('second'));
    await eventually('the reconnect', () => subscriptions(state).some(([c]) => c === 2));
    const second = subscriptions(state).filter(([c]) => c === 2);
    expect(second).toHaveLength(1);
    expect(filterOf(second[0]![1])).toBe('second');
    stream.close();
  });

  it('clamp a fromSlot older than the replay window', async () => {
    const state = newState({ replay: { firstAvailable: 500n } });
    const url = await serve(state);
    const stream = client(url).subscribeWith(() => named('x', 100n));
    const events = stream.events();
    await stream.next();
    expect(subscriptions(state)[0]![1].fromSlot).toBe(500n);
    expect(await drain(events)).toContainEqual({
      type: 'replayClamped',
      requested: 100n,
      available: 500n,
    });
    stream.close();
  });

  it('keep a fromSlot inside the window', async () => {
    const state = newState({ replay: { firstAvailable: 50n } });
    const url = await serve(state);
    const stream = client(url).subscribeWith(() => named('x', 100n));
    const events = stream.events();
    await stream.next();
    expect(subscriptions(state)[0]![1].fromSlot).toBe(100n);
    const seen = await drain(events);
    expect(seen.some((e) => e.type === 'replayClamped' || e.type === 'replayUnavailable')).toBe(
      false,
    );
    stream.close();
  });

  it('start live on servers without replay', async () => {
    const state = newState({ replay: {} });
    const url = await serve(state);
    const stream = client(url).subscribeWith(() => named('x', 100n));
    const events = stream.events();
    await stream.next();
    expect(subscriptions(state)[0]![1].fromSlot).toBeUndefined();
    expect(await drain(events)).toContainEqual({ type: 'replayUnavailable', requested: 100n });
    stream.close();
  });

  it('leave fromSlot to the server when the replay lookup fails', async () => {
    const state = newState();
    const url = await serve(state);
    const stream = client(url).subscribeWith(() => named('x', 100n));
    await stream.next();
    expect(subscriptions(state)[0]![1].fromSlot).toBe(100n);
    stream.close();
  });

  it('end the stream and say so when the retry policy is exhausted', async () => {
    const url = await serve(newState());
    servers.pop()!.forceShutdown();
    const stream = new GeyserClientBuilder()
      .url(url)
      .timeoutSecs(2)
      .retry(retry({ initialDelayMs: 10, maxDelayMs: 10, maxAttempts: 2 }))
      .build()
      .subscribe(named('x'));
    const events = stream.events();
    await expect(stream.next()).rejects.toThrow();
    expect(await stream.next()).toBeUndefined();
    const retries = (await drain(events))
      .filter((e) => e.type === 'disconnected')
      .map((e) => e.type === 'disconnected' && e.retryInMs !== undefined);
    expect(retries).toEqual([true, false]);
  });
});

async function rejected(code: grpc.status, maxAttempts: number) {
  const state = newState({ reject: code });
  const url = await serve(state);
  const stream = client(url, retry({ initialDelayMs: 10, maxDelayMs: 10, maxAttempts })).subscribe(
    named('x'),
  );
  const events = stream.events();
  const first = await Promise.race([
    stream.next().then(
      () => 'value',
      () => 'error',
    ),
    sleep(5000).then(() => 'timeout'),
  ]);
  expect(first).toBe('error');
  expect(await stream.next()).toBeUndefined();
  return { events: await drain(events), connections: state.connections };
}

describe('gRPC rejections', () => {
  it('are not retried when the request is invalid', async () => {
    const { events, connections } = await rejected(grpc.status.INVALID_ARGUMENT, 0);
    expect(connections).toBe(1);
    const last = events[events.length - 1];
    expect(last?.type).toBe('disconnected');
    expect(last?.type === 'disconnected' && last.retryInMs).toBeUndefined();
  });

  it('count against the retry policy when no message arrived', async () => {
    const { events, connections } = await rejected(grpc.status.INTERNAL, 3);
    expect(connections).toBe(3);
    const attempts = events.flatMap((e) => (e.type === 'connecting' ? [e.attempt] : []));
    expect(attempts).toEqual([1, 2, 3]);
  });
});
