import { describe, expect, it } from 'vitest';

import {
  JetstreamClientBuilder,
  type SlotEvent,
  SlotStatus,
  type SlotStream,
  TransactionFilter,
} from '../src/jetstream/v2.js';
import { type TransactionMessage } from '../src/proto/jetstream_v2.js';

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

const client = () => new JetstreamClientBuilder().build();

const sleep = (ms: number) => new Promise<undefined>((r) => setTimeout(() => r(undefined), ms));

async function collectSlots(stream: SlotStream, ms: number): Promise<SlotEvent[]> {
  const events: SlotEvent[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const event = await Promise.race([stream.next(), sleep(deadline - Date.now())]);
    if (event) events.push(event);
  }
  stream.close();
  return events;
}

const increasing = (events: SlotEvent[]) =>
  events.every((e, i) => i === 0 || e.sequence > events[i - 1]!.sequence);

describe.skipIf(!process.env.ORBITFLARE_JETSTREAM_URL)('JetStream v2 live', () => {
  it('unary calls', async () => {
    const c = client();
    expect(await c.getVersion()).not.toBe('');
    expect(await c.ping(7)).toBe(7);
  });

  it('slots without footers', { timeout: 30_000 }, async () => {
    const events = await collectSlots(client().subscribeSlots(), 15_000);
    expect(events.length).toBeGreaterThan(10);
    expect(increasing(events)).toBe(true);
    for (const ev of events) {
      expect(ev.status, 'footer without opt-in').not.toBe(SlotStatus.SLOT_STATUS_BLOCK_FOOTER);
      expect(ev.blockFooter).toBeUndefined();
    }
  });

  it('slots with footers', { timeout: 45_000 }, async () => {
    const events = await collectSlots(client().subscribeSlotsWithBlockFooters(), 30_000);
    expect(increasing(events)).toBe(true);

    let footers = 0;
    const seen = new Set<bigint>();
    for (const ev of events) {
      if (ev.status !== SlotStatus.SLOT_STATUS_BLOCK_FOOTER) {
        expect(ev.blockFooter, `footer on ${SlotStatus[ev.status]}`).toBeUndefined();
        continue;
      }
      footers += 1;
      expect(seen.has(ev.slot), `two footers for slot ${ev.slot}`).toBe(false);
      seen.add(ev.slot);
      const f = ev.blockFooter;
      expect(f, 'BLOCK_FOOTER event without footer').toBeDefined();
      expect(f!.slot).toBe(ev.slot);
      expect(f!.bankHash.length).toBe(32);
      expect([0, 32]).toContain(f!.blockId.length);
      expect(f!.blockUserAgent.length).toBeLessThanOrEqual(255);
      expect(f!.blockProducerTimeNanos).toBeGreaterThan(0n);
      const cert = f!.blockFinalCert;
      for (const agg of [cert?.finalAggregate, cert?.notarAggregate]) {
        if (!agg) continue;
        expect(agg.signature.length).toBe(96);
        expect([0, 32]).toContain(agg.blockId.length);
      }
    }
    expect(footers, `no footers in ${events.length} events`).toBeGreaterThan(0);
  });

  it('enriched transactions', { timeout: 40_000 }, async () => {
    const filter = new TransactionFilter()
      .accountInclude([COMPUTE_BUDGET])
      .includeEnrichment(true)
      .withId('cb');
    const stream = client().subscribeTransactions([filter]);

    let accepted = false;
    const txs: TransactionMessage[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && txs.length < 5000) {
      const resp = await Promise.race([stream.next(), sleep(deadline - Date.now())]);
      if (!resp) continue;
      if (resp.filterValidation) {
        expect(resp.filterValidation.accepted, resp.filterValidation.rejectionReason).toBe(true);
        accepted = true;
      } else if (resp.transaction) {
        expect(resp.transaction.filterIds).toEqual(['cb']);
        expect(resp.transaction.transaction, 'empty transaction').toBeDefined();
        txs.push(resp.transaction.transaction!);
      }
    }
    stream.close();

    expect(accepted, 'no filter_validation').toBe(true);
    expect(txs.length, 'no transactions').toBeGreaterThan(0);
    expect(
      txs.every((t) => t.feePayer.length === 32),
      'enrichment missing',
    ).toBe(true);
    expect(txs.some((t) => t.priorityFeeLamports > 0n)).toBe(true);

    const v1 = txs.filter((t) => t.config !== undefined);
    for (const t of v1) {
      const cfg = t.config!;
      expect(t.versioned, 'v1 tx with versioned=false').toBe(true);
      expect(t.priorityFeeLamports).toBe(cfg.priorityFee);
      expect(t.computeUnitPrice, 'v1 tx with compute_unit_price').toBe(0n);
      expect([0, 0b11]).toContain(cfg.configMask & 0b11);
      expect(
        cfg.heapSize === 0 ||
          (cfg.heapSize % 1024 === 0 && cfg.heapSize >= 32768 && cfg.heapSize <= 262144),
      ).toBe(true);
    }
    console.log(`${txs.length} txs, ${v1.length} v1`);
  });

  it('streams report connection events', { timeout: 60_000 }, async () => {
    const c = client();
    const txs = c.subscribeTransactions([
      new TransactionFilter().accountInclude([COMPUTE_BUDGET]).withId('events'),
    ]);
    const slots = c.subscribeSlots();
    const txEvents = txs.events();
    const slotEvents = slots.events();
    await Promise.race([txs.next(), sleep(20_000)]);
    await Promise.race([slots.next(), sleep(20_000)]);
    for (const events of [txEvents, slotEvents]) {
      expect(await events.recv()).toMatchObject({ type: 'connecting', attempt: 1 });
      expect(await events.recv()).toMatchObject({ type: 'connected' });
    }
    txs.close();
    slots.close();
  });
});
