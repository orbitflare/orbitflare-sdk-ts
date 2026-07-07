import bs58 from 'bs58';

import {
  JetstreamClientBuilder,
  SubscribeRequestBuilder,
  TransactionFilter,
} from '@orbitflare/sdk/jetstream';

const PUMP_FUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const WSOL = 'So11111111111111111111111111111111111111112';

async function main() {
  const url = process.env.ORBITFLARE_JETSTREAM_URL ?? 'http://slc.jetstream.orbitflare.com';
  const client = new JetstreamClientBuilder().url(url).build();

  const request = new SubscribeRequestBuilder()
    .transactions(
      'pumpfun',
      new TransactionFilter().accountInclude([PUMP_FUN]).accountRequired([WSOL]),
    )
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
    }
  }
}

void main();
