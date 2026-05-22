import bs58 from 'bs58';

import { JetstreamClientBuilder } from '@orbitflare/sdk/jetstream';

async function main() {
  const client = new JetstreamClientBuilder().url('http://ams.jetstream.orbitflare.com').build();
  const stream = client.subscribeYaml('examples/config/jetstream.yml');

  for await (const update of stream) {
    if (update.transaction) {
      const info = update.transaction.transaction;
      if (info?.signature) {
        const sig = bs58.encode(info.signature);
        console.log(`jet tx slot=${update.transaction.slot} sig=${sig.slice(0, 12)}`);
      }
    }
  }
}

void main();
