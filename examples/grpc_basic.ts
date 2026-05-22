import bs58 from 'bs58';

import { GeyserClientBuilder } from '@orbitflare/sdk/grpc';

async function main() {
  const client = new GeyserClientBuilder().url('http://ams.rpc.orbitflare.com:10000').build();
  const stream = client.subscribeYaml('examples/config/grpc.yml');

  for await (const update of stream) {
    if (update.transaction) {
      const info = update.transaction.transaction;
      if (info?.signature) {
        const sig = bs58.encode(info.signature);
        console.log(`tx slot=${update.transaction.slot} sig=${sig.slice(0, 12)}`);
      }
    } else if (update.pong) {
      console.log(`pong id=${update.pong.id}`);
    }
  }
}

void main();
