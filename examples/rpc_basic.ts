import { RpcClientBuilder } from '@orbitflare/sdk';

async function main() {
  const client = new RpcClientBuilder()
    .url('http://ams.rpc.orbitflare.com')
    .commitment('confirmed')
    .build();

  const slot = await client.getSlot();
  console.log(`slot: ${slot}`);

  const balance = await client.getBalance('CKs1E69a2e9TmH4mKKLrXFF8kD3ZnwKjoEuXa6sz9WqX');
  console.log(`balance: ${balance} lamports`);

  const { blockhash, lastValidBlockHeight } = await client.getLatestBlockhash();
  console.log(`blockhash: ${blockhash} (valid until block ${lastValidBlockHeight})`);

  const inflation = await client.request('getInflationRate', []);
  console.log('inflation:', inflation);

  const raw = await client.requestRaw('{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}');
  console.log('health:', raw);
}

void main();
