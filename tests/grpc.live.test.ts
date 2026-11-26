import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import { type ConnectionEvent } from '../src/events.js';
import {
  BlockFooterFilter,
  Commitment,
  GeyserClientBuilder,
  type GeyserStream,
  SlotFilter,
  SubscribeRequestBuilder,
  TransactionFilter,
} from '../src/grpc.js';
import { type SubscribeRequest, type SubscribeUpdate } from '../src/proto/geyser.js';

const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

const client = () => new GeyserClientBuilder().build();

const sleep = (ms: number) => new Promise<undefined>((r) => setTimeout(() => r(undefined), ms));

async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function collect(request: SubscribeRequest, ms: number): Promise<SubscribeUpdate[]> {
  const stream = client().subscribe(request);
  const out: SubscribeUpdate[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const update = await Promise.race([stream.next(), sleep(deadline - Date.now())]);
    if (update) out.push(update);
  }
  stream.close();
  return out;
}

function watching(account: string): SubscribeRequest {
  return new SubscribeRequestBuilder()
    .transactions('t', new TransactionFilter().vote(false).accountInclude([account]))
    .slots('s', new SlotFilter())
    .commitment(Commitment.Processed)
    .build();
}

function accountsOf(update: SubscribeUpdate): string[] | undefined {
  const info = update.transaction?.transaction;
  const message = info?.transaction?.message;
  if (!info || !message) return undefined;
  const keys = [
    ...message.accountKeys,
    ...(info.meta?.loadedWritableAddresses ?? []),
    ...(info.meta?.loadedReadonlyAddresses ?? []),
  ];
  return keys.map((k) => bs58.encode(k));
}

async function nextTx(stream: GeyserStream): Promise<string[]> {
  for (;;) {
    const update = await stream.next();
    if (!update) throw new Error('stream ended');
    const accounts = accountsOf(update);
    if (accounts) return accounts;
  }
}

describe.skipIf(!process.env.ORBITFLARE_GRPC_URL)('gRPC live', () => {
  it('block footers with certificates', { timeout: 40_000 }, async () => {
    const request = new SubscribeRequestBuilder()
      .blockFooter('f', new BlockFooterFilter().includeCertificates(true))
      .commitment(Commitment.Processed)
      .build();
    const updates = await collect(request, 20_000);

    const slots = new Set<string>();
    let withFinal = 0;
    for (const u of updates) {
      const f = u.blockFooter;
      if (!f) continue;
      expect(u.filters).toEqual(['f']);
      const key = `${f.slot}:${f.bankId}`;
      expect(slots.has(key), `duplicate footer ${f.slot}`).toBe(false);
      slots.add(key);
      expect(f.bankId).toBeGreaterThan(0n);
      expect(f.bankHash.length).toBe(32);
      expect(f.blockUserAgent.length).toBeLessThanOrEqual(255);
      expect(f.blockProducerTimeNanos).toBeGreaterThan(0n);
      const cert = f.blockFinalCert;
      if (cert) {
        withFinal += 1;
        expect(cert.slot).toBeLessThanOrEqual(f.slot);
        for (const agg of [cert.finalAggregate, cert.notarAggregate]) {
          if (!agg) continue;
          expect(agg.signature.length).toBe(96);
          expect([0, 32]).toContain(agg.blockId.length);
          expect(agg.signerBitmap.length).toBeGreaterThan(0);
        }
      }
    }
    expect(slots.size, `no footers in ${updates.length} updates`).toBeGreaterThan(0);
    expect(withFinal, 'no footer carried a final cert').toBeGreaterThan(0);
    console.log(`${slots.size} footers, ${withFinal} with final cert`);
  });

  it('block footers without certificates', { timeout: 30_000 }, async () => {
    const request = new SubscribeRequestBuilder()
      .blockFooter('f', new BlockFooterFilter())
      .commitment(Commitment.Processed)
      .build();
    const footers = (await collect(request, 10_000)).flatMap((u) =>
      u.blockFooter ? [u.blockFooter] : [],
    );
    expect(footers.length, 'no footers').toBeGreaterThan(0);
    for (const f of footers) {
      expect(f.bankHash.length).toBe(32);
      expect(f.blockFinalCert).toBeUndefined();
      expect(f.skipRewardCert).toBeUndefined();
      expect(f.notarRewardCert).toBeUndefined();
    }
  });

  it('bank ids and v1 transactions', { timeout: 40_000 }, async () => {
    const request = new SubscribeRequestBuilder()
      .slots('s', new SlotFilter().filterByCommitment(false))
      .transactions('t', new TransactionFilter().vote(false).accountInclude([COMPUTE_BUDGET]))
      .commitment(Commitment.Processed)
      .build();
    const updates = await collect(request, 20_000);

    let txs = 0;
    let v1 = 0;
    let slots = 0;
    for (const u of updates) {
      if (u.transaction) {
        txs += 1;
        expect(u.transaction.bankId, 'transaction without bank_id').toBeGreaterThan(0n);
        const msg = u.transaction.transaction?.transaction?.message;
        expect(msg, 'transaction without message').toBeDefined();
        if (msg?.config) {
          v1 += 1;
          expect(msg.versioned, 'v1 tx with versioned=false').toBe(true);
        }
      } else if (u.slot) {
        slots += 1;
        expect(u.slot.slot).toBeGreaterThan(0n);
      }
    }
    expect(txs).toBeGreaterThan(0);
    expect(slots).toBeGreaterThan(0);
    console.log(`${txs} txs (${v1} v1), ${slots} slot updates`);
  });

  it('update replaces filters without reconnecting', { timeout: 120_000 }, async () => {
    const stream = client().subscribe(watching(JUPITER));
    const events = stream.events();
    const first = await within(30_000, 'a Jupiter transaction', nextTx(stream));
    expect(first).toContain(JUPITER);

    stream.update(watching(PUMP));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await Promise.race([stream.next(), sleep(deadline - Date.now())]);
    }
    for (let i = 0; i < 20; i++) {
      const accounts = await within(30_000, 'a pump.fun transaction', nextTx(stream));
      expect(accounts, 'old filter still applied').toContain(PUMP);
    }
    let connects = 0;
    for (let e = events.tryRecv(); e !== undefined; e = events.tryRecv()) {
      if (e.type === 'connected') connects += 1;
      if (e.type === 'disconnected') throw new Error(`disconnected: ${e.error}`);
    }
    expect(connects, 'the update must not reconnect').toBe(1);
    stream.close();
  });

  it('a replay catches up with the live stream', { timeout: 60_000 }, async () => {
    const live = client().subscribe(watching(JUPITER));
    let tip = 0n;
    void (async () => {
      for await (const u of live)
        if (u.transaction && u.transaction.slot > tip) tip = u.transaction.slot;
    })();
    await within(
      30_000,
      'a live transaction',
      (async () => {
        while (tip === 0n) await sleep(100);
      })(),
    );
    const replay = client().subscribeWith(() => ({ ...watching(JUPITER), fromSlot: tip - 32n }));
    let max = 0n;
    void (async () => {
      for await (const u of replay)
        if (u.transaction && u.transaction.slot > max) max = u.transaction.slot;
    })();
    await within(
      20_000,
      'the replay to reach the live tip',
      (async () => {
        while (max === 0n || max < tip - 2n) await sleep(200);
      })(),
    );
    replay.close();
    live.close();
  });

  it('subscribeWith replays from the requested slot', { timeout: 120_000 }, async () => {
    const probe = client().subscribe(watching(JUPITER));
    let now = 0n;
    while (now === 0n) {
      const update = await probe.next();
      if (update?.slot) now = update.slot.slot;
    }
    probe.close();

    const from = now - 150n;
    const stream = client().subscribeWith((info) => {
      expect(info.reconnect).toBe(false);
      return { ...watching(JUPITER), fromSlot: from };
    });
    let firstTxSlot: bigint | undefined;
    while (firstTxSlot === undefined) {
      const update = await within(60_000, 'a replayed transaction', stream.next());
      if (update?.transaction) firstTxSlot = update.transaction.slot;
    }
    expect(
      firstTxSlot >= from && firstTxSlot < now,
      `first tx at ${firstTxSlot}, from ${from}, now ${now}`,
    ).toBe(true);
    stream.close();

    const old = client().subscribeWith(() => ({ ...watching(JUPITER), fromSlot: 1n }));
    const events = old.events();
    await within(60_000, 'the clamped stream', old.next());
    let clamped: Extract<ConnectionEvent, { type: 'replayClamped' }> | undefined;
    for (let e = events.tryRecv(); e !== undefined; e = events.tryRecv()) {
      if (e.type === 'replayClamped') clamped = e;
    }
    expect(clamped, 'expected the slot to be clamped').toBeDefined();
    expect(clamped!.requested).toBe(1n);
    expect(clamped!.available > 1n && clamped!.available <= now).toBe(true);
    old.close();
  });
});
