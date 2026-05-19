import { WsClientBuilder } from '@orbitflare/sdk';

async function main() {
  const client = await new WsClientBuilder().url('ws://ams.rpc.orbitflare.com').build();

  const slots = await client.slotSubscribe();
  const usdc = await client.accountSubscribe(
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'confirmed',
  );

  console.log('watching slots and USDC mint account...');

  slots.on((slot) => {
    const s = slot?.slot ?? 0;
    const parent = slot?.parent ?? 0;
    console.log(`slot ${s} (parent ${parent})`);
  });

  usdc.on((acct) => {
    const lamports = acct?.lamports ?? 0;
    const data = acct?.data?.[0];
    const dataLen = typeof data === 'string' ? data.length : 0;
    console.log(`USDC mint updated: ${lamports} lamports, ${dataLen} bytes`);
  });

  await new Promise(() => {});
}

void main();
