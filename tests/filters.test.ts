import { describe, expect, it } from 'vitest';

import { Commitment, Lamports, Memcmp } from '../src/filters.js';
import {
  AccountFilter,
  BlockFilter,
  DeshredTransactionFilter,
  SlotFilter,
  SubscribeRequestBuilder,
  TransactionFilter,
} from '../src/grpc.js';
import {
  SubscribeRequestBuilder as JetSubscribeRequestBuilder,
  TransactionFilter as JetTransactionFilter,
} from '../src/jetstream/filters.js';

describe('Memcmp', () => {
  it('builds the bytes/base58/base64 variants', () => {
    expect(Memcmp.bytes(8, new Uint8Array([1, 2, 3])).data).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(Memcmp.base58(0, 'abc').data).toEqual({ base58: 'abc' });
    expect(Memcmp.base64(4, 'ZGVm').data).toEqual({ base64: 'ZGVm' });
    expect(Memcmp.base58(0, 'abc').offset).toBe(0);
  });
});

describe('Lamports', () => {
  it('builds the comparison variants', () => {
    expect(Lamports.eq(1).cmp).toEqual({ eq: 1 });
    expect(Lamports.ne(2).cmp).toEqual({ ne: 2 });
    expect(Lamports.lt(3).cmp).toEqual({ lt: 3 });
    expect(Lamports.gt(4).cmp).toEqual({ gt: 4 });
  });
});

describe('gRPC SubscribeRequestBuilder', () => {
  it('maps typed filters into a SubscribeRequest', () => {
    const req = new SubscribeRequestBuilder()
      .transactions(
        'txs',
        new TransactionFilter().vote(false).failed(false).accountInclude(['acc1']),
      )
      .accounts(
        'accs',
        new AccountFilter()
          .owner(['owner1'])
          .datasize(165)
          .memcmp(Memcmp.base58(0, 'mint'))
          .lamports(Lamports.gt(0))
          .tokenAccountState(true),
      )
      .slots('slots', new SlotFilter().filterByCommitment(true))
      .blocks('blocks', new BlockFilter().accountInclude(['acc1']).includeTransactions(true))
      .blocksMeta('meta')
      .entry('entry')
      .commitment(Commitment.Confirmed)
      .accountsDataSlice(0, 32)
      .fromSlot(100)
      .build();

    expect(req.transactions['txs']).toEqual({
      vote: false,
      failed: false,
      signature: undefined,
      accountInclude: ['acc1'],
      accountExclude: [],
      accountRequired: [],
    });
    expect(req.accounts['accs']!.owner).toEqual(['owner1']);
    expect(req.accounts['accs']!.filters).toEqual([
      { datasize: 165n },
      { memcmp: { offset: 0n, base58: 'mint' } },
      { lamports: { gt: 0n } },
      { tokenAccountState: true },
    ]);
    expect(req.slots['slots']).toEqual({
      filterByCommitment: true,
      interslotUpdates: undefined,
    });
    expect(req.blocks['blocks']!.includeTransactions).toBe(true);
    expect(req.blocksMeta['meta']).toEqual({});
    expect(req.entry['entry']).toEqual({});
    expect(req.commitment).toBe(Commitment.Confirmed);
    expect(req.accountsDataSlice).toEqual([{ offset: 0n, length: 32n }]);
    expect(req.fromSlot).toBe(100n);
    // Vanilla Yellowstone ignores the filters of a request that carries a ping.
    expect(req.ping).toBeUndefined();
  });

  it('builds a DeshredTransactionFilter', () => {
    const proto = new DeshredTransactionFilter()
      .vote(false)
      .accountInclude(['acc1'])
      .accountExclude(['acc2'])
      .toProto();
    expect(proto).toEqual({
      vote: false,
      accountInclude: ['acc1'],
      accountExclude: ['acc2'],
      accountRequired: [],
    });
  });
});

describe('JetStream v1 SubscribeRequestBuilder', () => {
  it('maps transaction filters (transactions-only)', () => {
    const req = new JetSubscribeRequestBuilder()
      .transactions(
        'txs',
        new JetTransactionFilter().accountInclude(['acc1']).accountRequired(['acc2']),
      )
      .build();

    expect(req.transactions['txs']).toEqual({
      accountInclude: ['acc1'],
      accountExclude: [],
      accountRequired: ['acc2'],
    });
    expect(req.accounts).toEqual({});
    expect(req.ping).toEqual({ id: 1 });
  });
});
