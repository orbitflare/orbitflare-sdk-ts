// End-to-end DAS tests against a live endpoint. Skipped unless ORBITFLARE_LICENSE_KEY is set:
//
//   ORBITFLARE_LICENSE_KEY=... npx vitest run tests/das.live.test.ts
//
// ORBITFLARE_RPC_URL overrides the endpoint (default Frankfurt).

import { describe, expect, it } from 'vitest';

import { assetCollection, assetName, assetOwner, isCompressed } from '../src/das.js';
import { OrbitflareError } from '../src/error.js';
import { RpcClientBuilder } from '../src/rpc.js';

const ORBITFLARE_PASS = 'GJfYbfW7gufzFYfm8gFatrUE71wYsjay6FwzDkTa3vaD';
const ORBITFLARE_PASSES = 'CDDyz6MHYY8972DPCXiEeReCxGqJSCbxHnimrvoyWrFF';
const ORBITFLARE_PASS_AUTHORITY = '9Ppfjr8tFAwK9xxvXsVN2xAaShRLZu5ZzDAwnCCLxewo';
// The OrbitFlare Pass creator is unverified, so the verified-creator check uses Mad Lads.
const MAD_LADS_CREATOR = '5XvhfmRjwXkGp3jHGmaKpqeerNYjkuZZBYLVQYdeVcRv';
// Unicat #91.
const CNFT = 'AssVbUqhyK9JWTRKTmd7verNPPCgFqupUMbhDDsc4TTU';
const CNFT_COLLECTION = 'EuRteU98mnoRAer1eSc8do2BLeyxkY3aWAbTW27BSMUx';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY';
const NOT_AN_ASSET = '11111111111111111111111111111111';

const client = () =>
  new RpcClientBuilder()
    .url(process.env.ORBITFLARE_RPC_URL ?? 'https://fra.rpc.orbitflare.com')
    .build();

const rpcCode = (e: unknown) => (e instanceof OrbitflareError ? e.rpc?.code : undefined);

describe.skipIf(!process.env.ORBITFLARE_LICENSE_KEY)('DAS live', () => {
  it('getAsset', async () => {
    const asset = await client().getAsset(ORBITFLARE_PASS);
    expect(asset.id).toBe(ORBITFLARE_PASS);
    expect(asset.interface).toBe('ProgrammableNFT');
    expect(assetName(asset)).toMatch(/^OrbitFlare Pass/);
    expect(assetCollection(asset)).toBe(ORBITFLARE_PASSES);
    expect(assetOwner(asset)).toBeTruthy();
    expect(asset.last_indexed_slot).toBeGreaterThan(0);

    const withMeta = await client().getAsset(ORBITFLARE_PASS, { showCollectionMetadata: true });
    expect(withMeta.grouping![0]!.collection_metadata).toBeDefined();
  });

  it('getAsset for a fungible token and a compressed NFT', async () => {
    const usdc = await client().getAsset(USDC);
    expect(usdc.interface).toBe('FungibleToken');
    expect(usdc.token_info!.decimals).toBe(6);

    const cnft = await client().getAsset(CNFT);
    expect(isCompressed(cnft)).toBe(true);
    expect(assetCollection(cnft)).toBe(CNFT_COLLECTION);
  });

  it('getAsset not found', async () => {
    const err = await client()
      .getAsset(NOT_AN_ASSET)
      .catch((e) => e);
    expect(rpcCode(err)).toBe(-32000);
  });

  it('getAssetBatch', async () => {
    const assets = await client().getAssetBatch([ORBITFLARE_PASS, NOT_AN_ASSET, CNFT]);
    expect(assets).toHaveLength(3);
    expect(assets[0]!.id).toBe(ORBITFLARE_PASS);
    expect(assets[1]).toBeNull();
    expect(assets[2]!.id).toBe(CNFT);
  });

  it('proofs', async () => {
    const c = client();
    const proof = await c.getAssetProof(CNFT);
    expect(proof.proof.length).toBeGreaterThan(0);
    expect(proof.root).toBeTruthy();

    const both = await c.getAssetWithProof(CNFT);
    expect(both.proof.tree_id).toBe(both.asset.compression!.tree);
    expect(both.proof.leaf).toBe(both.asset.compression!.asset_hash);

    const batch = await c.getAssetProofBatch([CNFT, ORBITFLARE_PASS]);
    expect(batch[CNFT]).toBeTruthy();
    expect(batch[ORBITFLARE_PASS] ?? null).toBeNull();

    const err = await c.getAssetProof(ORBITFLARE_PASS).catch((e) => e);
    expect(rpcCode(err)).toBe(-32000);
  });

  it('getAssetsByOwner with tokens', async () => {
    const list = await client().getAssetsByOwner({
      ownerAddress: WALLET,
      page: 1,
      limit: 50,
      options: { showFungible: true, showNativeBalance: true },
    });
    expect(list.page).toBe(1);
    expect(list.items.length).toBeLessThanOrEqual(50);
    expect(list.nativeBalance).toBeDefined();
    expect(list.items.every((a) => (assetOwner(a) ?? WALLET) === WALLET)).toBe(true);
  });

  it('list methods', async () => {
    const c = client();
    const group = await c.getAssetsByGroup({
      groupKey: 'collection',
      groupValue: ORBITFLARE_PASSES,
      limit: 3,
    });
    expect(group.items).toHaveLength(3);
    expect(group.items.every((a) => assetCollection(a) === ORBITFLARE_PASSES)).toBe(true);
    expect(group.cursor).toBeTruthy();

    const creator = await c.getAssetsByCreator({
      creatorAddress: MAD_LADS_CREATOR,
      onlyVerified: true,
      limit: 2,
    });
    expect(creator.items.length).toBeGreaterThan(0);
    expect(
      creator.items[0]!.creators!.some((cr) => cr.address === MAD_LADS_CREATOR && cr.verified),
    ).toBe(true);

    const authority = await c.getAssetsByAuthority({
      authorityAddress: ORBITFLARE_PASS_AUTHORITY,
      page: 1,
      limit: 2,
    });
    expect(authority.items.length).toBeGreaterThan(0);

    const sorted = await c.getAssetsByGroup({
      groupKey: 'collection',
      groupValue: ORBITFLARE_PASSES,
      sortBy: { sortBy: 'created', sortDirection: 'desc' },
      page: 1,
      limit: 2,
    });
    expect(sorted.items).toHaveLength(2);
  });

  it('searchAssets', async () => {
    const c = client();
    const fungible = await c.searchAssets({
      ownerAddress: WALLET,
      tokenType: 'fungible',
      limit: 5,
    });
    expect(fungible.items.every((a) => a.token_info !== undefined)).toBe(true);

    const inCollection = await c.searchAssets({
      grouping: ['collection', ORBITFLARE_PASSES],
      burnt: false,
      page: 1,
      limit: 2,
    });
    expect(inCollection.items).toHaveLength(2);
    expect(inCollection.items.every((a) => !a.burnt)).toBe(true);
  });

  it('getTokenAccounts', async () => {
    const list = await client().getTokenAccounts({ mint: USDC, limit: 5 });
    expect(list.token_accounts).toHaveLength(5);
    expect(list.token_accounts.every((t) => t.mint === USDC && t.amount > 0)).toBe(true);
  });

  it('getNftEditions', async () => {
    // OrbitFlare Passes aren't master editions, so this only checks the method is wired up.
    const r = await client()
      .getNftEditions({ mint: ORBITFLARE_PASS, limit: 5 })
      .catch((e) => e);
    if (r instanceof Error) expect(rpcCode(r)).toBe(-32000);
    else expect(typeof r.supply).toBe('number');
  });

  it('getSignaturesForAsset', async () => {
    const sigs = await client().getSignaturesForAsset({ id: CNFT, limit: 5 });
    expect(sigs.items.length).toBeGreaterThan(0);
    expect(sigs.items.every((s) => s.signature && s.instruction)).toBe(true);
  });

  it('pages by cursor', async () => {
    const pages = client().pages('getAssetsByGroup', {
      groupKey: 'collection',
      groupValue: ORBITFLARE_PASSES,
      limit: 5,
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const page = (await pages.nextPage())!;
      expect(page.items).toHaveLength(5);
      ids.push(...page.items.map((a) => a.id));
    }
    expect(new Set(ids).size).toBe(15);
  });
});
