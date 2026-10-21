import { RpcClientBuilder, assetName, assetOwner } from '@orbitflare/sdk';

async function main() {
  const client = new RpcClientBuilder().url('https://fra.rpc.orbitflare.com').build();

  const asset = await client.getAsset('GJfYbfW7gufzFYfm8gFatrUE71wYsjay6FwzDkTa3vaD');
  console.log(`${assetName(asset) ?? '?'} (${asset.interface}), owner ${assetOwner(asset) ?? '?'}`);

  const portfolio = await client.getAssetsByOwner({
    ownerAddress: '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY',
    page: 1,
    limit: 100,
    options: { showFungible: true, showNativeBalance: true },
  });
  if (portfolio.nativeBalance) {
    const sol = portfolio.nativeBalance;
    console.log(`SOL: ${sol.lamports} lamports ($${(sol.total_price ?? 0).toFixed(2)})`);
  }
  console.log(`${portfolio.items.length} assets on page 1`);

  const tokens = await client.searchAssets({
    ownerAddress: '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY',
    tokenType: 'fungible',
  });
  for (const t of tokens.items) {
    console.log(`${(t.token_info?.symbol ?? '?').padStart(10)} ${t.token_info?.balance ?? 0}`);
  }

  const { asset: cnft, proof } = await client.getAssetWithProof(
    'AssVbUqhyK9JWTRKTmd7verNPPCgFqupUMbhDDsc4TTU',
  );
  console.log(
    `cNFT leaf ${cnft.compression?.leaf_id} in tree ${proof.tree_id}, ${proof.proof.length} proof nodes`,
  );

  // Walk a whole collection, page by page.
  const holders = new Map<string, number>();
  for await (const page of client.pages('getAssetsByGroup', {
    groupKey: 'collection',
    groupValue: 'CDDyz6MHYY8972DPCXiEeReCxGqJSCbxHnimrvoyWrFF',
  })) {
    for (const a of page.items) {
      const owner = assetOwner(a);
      if (owner) holders.set(owner, (holders.get(owner) ?? 0) + 1);
    }
  }
  console.log(`${holders.size} holders`);
}

void main();
