import bs58 from 'bs58';

import { JetstreamClientBuilder } from '@orbitflare/sdk/jetstream';

async function main() {
  const client = new JetstreamClientBuilder().url('http://ams.jetstream.orbitflare.com').build();
  const stream = client.subscribeYaml('examples/config/jetstream.yml');
  let count = 0;

  console.log('streaming raydium txs...');

  for await (const update of stream) {
    if (update.transaction) {
      count += 1;
      const info = update.transaction.transaction;
      if (info?.signature) {
        const sig = bs58.encode(info.signature);
        const numIx = info.instructions.length;
        const numAccounts = info.accountKeys.length;
        console.log(
          `#${count} slot=${update.transaction.slot} sig=${sig.slice(0, 16)}... ix=${numIx} accounts=${numAccounts}`,
        );
      }
    }
  }
}

void main();
