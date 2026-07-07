import bs58 from 'bs58';

import {
  AccountFilter,
  Commitment,
  GeyserClientBuilder,
  Lamports,
  Memcmp,
  SlotFilter,
  SubscribeRequestBuilder,
  TransactionFilter,
} from '@orbitflare/sdk/grpc';

const PUMP_FUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WSOL = 'So11111111111111111111111111111111111111112';

async function main() {
  const url = process.env.ORBITFLARE_GRPC_URL ?? 'http://slc.rpc.orbitflare.com:10000';
  const client = new GeyserClientBuilder().url(url).build();

  const request = new SubscribeRequestBuilder()
    .transactions(
      'pumpfun',
      new TransactionFilter()
        .vote(false)
        .failed(false)
        .accountInclude([PUMP_FUN])
        .accountRequired([WSOL]),
    )
    .accounts(
      'wsol-token-accounts',
      new AccountFilter()
        .owner([TOKEN_PROGRAM])
        .datasize(165)
        .memcmp(Memcmp.base58(0, WSOL))
        .lamports(Lamports.gt(0)),
    )
    .slots('slots', new SlotFilter().filterByCommitment(true))
    .commitment(Commitment.Confirmed)
    .build();

  const stream = client.subscribe(request);

  for await (const update of stream) {
    if (update.transaction) {
      const info = update.transaction.transaction;
      if (info?.signature) {
        const sig = bs58.encode(info.signature);
        console.log(
          `tx slot=${update.transaction.slot} sig=${sig.slice(0, 12)} filters=${JSON.stringify(update.filters)}`,
        );
      }
    } else if (update.account) {
      console.log(`account slot=${update.account.slot} filters=${JSON.stringify(update.filters)}`);
    } else if (update.slot) {
      console.log(`slot ${update.slot.slot}`);
    }
  }
}

void main();
