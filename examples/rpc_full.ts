import { RpcClientBuilder } from '@orbitflare/sdk';

async function main() {
  const client = new RpcClientBuilder()
    .url('http://ams.rpc.orbitflare.com')
    .fallbackUrl('http://fra.rpc.orbitflare.com')
    .commitment('confirmed')
    .build();

  const wallet = 'CKs1E69a2e9TmH4mKKLrXFF8kD3ZnwKjoEuXa6sz9WqX';

  const slot = await client.getSlot();
  const { blockhash } = await client.getLatestBlockhash();
  console.log(`network slot: ${slot}`);
  console.log(`blockhash: ${blockhash}`);

  const balance = await client.getBalance(wallet);
  console.log(`\n${wallet}`);
  console.log(`  SOL: ${(balance / 1_000_000_000).toFixed(4)}`);

  const tokens = await client.getTokenAccountsByOwner(wallet);
  for (const token of tokens) {
    const info = token?.account?.data?.parsed?.info;
    const mint = info?.mint ?? 'unknown';
    const amount = info?.tokenAmount?.uiAmountString ?? '0';
    if (amount !== '0') console.log(`  ${mint}: ${amount}`);
  }

  const sigs = await client.getSignaturesForAddress(wallet, 5);
  console.log('\nrecent transactions:');
  for (const sig of sigs) {
    const signature = sig?.signature ?? '?';
    const sigSlot = sig?.slot ?? 0;
    const status = sig?.err == null ? 'ok' : 'failed';
    console.log(`  ${sigSlot} ${status} ${signature.slice(0, 20)}`);
  }

  const fees = await client.getRecentPrioritizationFees([wallet]);
  const total = fees.reduce(
    (acc: number, f: any) =>
      acc + (typeof f?.prioritizationFee === 'number' ? f.prioritizationFee : 0),
    0,
  );
  const avg = total / Math.max(fees.length, 1);
  console.log(`\navg priority fee: ${avg.toFixed(0)} micro-lamports`);
}

void main();
