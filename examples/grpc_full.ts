import bs58 from 'bs58';

import { GeyserClientBuilder } from '@orbitflare/sdk';

async function main() {
  const client = new GeyserClientBuilder()
    .url('http://ams.rpc.orbitflare.com:10000')
    .fallbackUrl('http://fra.rpc.orbitflare.com:10000')
    .build();

  const stream = client.subscribeYaml('examples/config/grpc.yml');
  let txCount = 0;

  console.log('streaming...');

  for await (const update of stream) {
    if (update.transaction) {
      txCount += 1;
      const info = update.transaction.transaction;
      if (info?.signature) {
        const sig = bs58.encode(info.signature);
        const fee = info.meta?.fee ?? 0n;
        const ixCount = info.transaction?.message?.instructions.length ?? 0;
        console.log(
          `#${txCount} slot=${update.transaction.slot} sig=${sig.slice(0, 16)}... fee=${fee} instructions=${ixCount}`,
        );
      }
    } else if (update.slot) {
      console.log(`slot ${update.slot.slot} (${update.slot.status})`);
    }
  }
}

void main();
