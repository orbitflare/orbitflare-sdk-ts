import bs58 from 'bs58';

import { JetstreamClientBuilder, TransactionFilter } from '@orbitflare/sdk/jetstream/v2';

async function main() {
  const url = process.env.ORBITFLARE_JETSTREAM_URL ?? 'http://slc.jetstream.orbitflare.com';
  const client = new JetstreamClientBuilder().url(url).build();

  try {
    console.log(`version=${await client.getVersion()}`);
  } catch (e) {
    console.log(`get_version error: ${String(e)}`);
  }
  try {
    console.log(`ping=${await client.ping(7)}`);
  } catch (e) {
    console.log(`ping error: ${String(e)}`);
  }

  const filter = new TransactionFilter()
    .accountInclude(['So11111111111111111111111111111111111111112'])
    .includeEnrichment(true)
    .withId('wsol');
  const stream = client.subscribeTransactions([filter]);

  for await (const resp of stream) {
    if (resp.transaction) {
      const tx = resp.transaction.transaction;
      if (tx) {
        const sig = bs58.encode(tx.signature);
        console.log(
          `seq=${resp.sequence} slot=${tx.slot} sig=${sig.slice(0, 12)} matched=${JSON.stringify(resp.transaction.filterIds)}`,
        );
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
}

void main();
