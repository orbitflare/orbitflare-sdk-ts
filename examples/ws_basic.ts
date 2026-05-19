import { WsClientBuilder } from '@orbitflare/sdk';

async function main() {
  const client = await new WsClientBuilder().url('ws://ams.rpc.orbitflare.com').build();

  const sub = await client.slotSubscribe();

  while (true) {
    const slot = await sub.next();
    if (slot === undefined) break;
    console.log(`slot: ${JSON.stringify(slot)}`);
  }

  await sub.unsubscribe();
}

void main();
