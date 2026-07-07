import bs58 from 'bs58';

import { JetstreamClientBuilder, TransactionFilter } from '@orbitflare/sdk/jetstream/v2';
import { jetstreamV2 } from '@orbitflare/sdk/proto';

const WSOL = 'So11111111111111111111111111111111111111112';
const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

async function main() {
  const url = process.env.ORBITFLARE_JETSTREAM_URL ?? 'http://slc.jetstream.orbitflare.com';
  const client = new JetstreamClientBuilder()
    .url(url)
    .fallbackUrl('http://ams.jetstream.orbitflare.com')
    .build();

  try {
    console.log(`version=${await client.getVersion()}`);
    console.log(`ping=${await client.ping(7)}`);
  } catch (e) {
    console.log(`unary error: ${String(e)}`);
  }

  const slots = client.subscribeSlots();
  const slotLoop = (async () => {
    for await (const event of slots) {
      console.log(`slot=${event.slot} status=${jetstreamV2.slotStatusToJSON(event.status)}`);
    }
  })();

  const stream = client.subscribeTransactions([
    new TransactionFilter().accountInclude([WSOL]).includeEnrichment(true).withId('wsol'),
  ]);
  const handle = stream.handle();

  let count = 0;
  const txLoop = (async () => {
    for await (const resp of stream) {
      if (resp.transaction) {
        const tx = resp.transaction.transaction;
        if (tx) {
          const sig = bs58.encode(tx.signature);
          console.log(
            `seq=${resp.sequence} slot=${tx.slot} cuPrice=${tx.computeUnitPrice} sig=${sig.slice(0, 12)} matched=${JSON.stringify(resp.transaction.filterIds)}`,
          );
        }

        if (++count === 5) {
          handle.addFilters([new TransactionFilter().accountInclude([RAYDIUM]).withId('raydium')]);
          handle.removeFilters(['wsol']);
          console.log('swapped wsol -> raydium on the live stream');
        }
      } else if (resp.filterValidation) {
        const r = resp.filterValidation;
        console.log(`filter ${r.filterId} accepted=${r.accepted} ${r.rejectionReason}`);
      } else if (resp.heartbeat) {
        console.log(`heartbeat ts_ms=${resp.heartbeat.serverTsMs}`);
      } else if (resp.pong) {
        console.log(`pong id=${resp.pong.pingId}`);
      }
    }
  })();

  await Promise.all([txLoop, slotLoop]);
}

void main();
