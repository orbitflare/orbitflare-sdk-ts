import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

import {
  assetCollection,
  assetImage,
  assetName,
  assetOwner,
  assetSymbol,
  isCompressed,
  proofPath,
} from '../src/das.js';
import { OrbitflareError } from '../src/error.js';
import { RpcClientBuilder } from '../src/rpc.js';

const ORIGIN = 'http://orbitflare.test';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = (maxAttempts = 1) =>
  new RpcClientBuilder()
    .url(ORIGIN)
    .retry({ initialDelayMs: 1, maxDelayMs: 5, multiplier: 1.5, maxAttempts })
    .build();

/** Answers every request with `respond(body)` and records the bodies. */
function mock(respond: (body: any) => unknown) {
  const bodies: any[] = [];
  server.use(
    http.post(ORIGIN, async ({ request }) => {
      const body = await request.json();
      bodies.push(body);
      return HttpResponse.json(respond(body) as any);
    }),
  );
  return bodies;
}

const result = (r: unknown) => mock(() => ({ jsonrpc: '2.0', id: 1, result: r }));

/** The compressed DRiP NFT from the getAsset docs. */
const dripCnft = () => ({
  last_indexed_slot: 457714576,
  interface: 'V1_NFT',
  id: 'JEKNNLZK6uQaQUEUz9GRoYZ7buHQ4rTN6k3qhX9NG8qU',
  content: {
    $schema: 'https://schema.metaplex.com/nft1.0.json',
    json_uri: 'https://arweave.net/ymSDHwAqb3hnNKBid03WBUqY1Svj5Hzr0fdAYGvZBKA',
    files: [
      {
        uri: 'https://arweave.net/2dfCrqZmpUTPEaPHuI9QUdZocNa-JYkG-3nBKycF-AM?ext=jpg',
        mime: 'image/jpeg',
      },
    ],
    metadata: {
      attributes: [
        { value: '3', trait_type: 'Season' },
        { value: 'Common', trait_type: 'Rarity' },
      ],
      description:
        'Combination between Angkor Wat photography with microscopic creation as the sky.',
      name: 'Aurora borealis',
      symbol: '',
      token_standard: 'NonFungible',
    },
    links: {
      external_url: 'https://drip.haus/showcase',
      image: 'https://arweave.net/2dfCrqZmpUTPEaPHuI9QUdZocNa-JYkG-3nBKycF-AM?ext=jpg',
    },
    category: 'image',
  },
  authorities: [{ address: '5warkgXZEtubURnNHN1BcpgSBja31zeSvWudeXQEPpTr', scopes: ['full'] }],
  compression: {
    eligible: false,
    compressed: true,
    data_hash: '6TuHoKagPg1Vqz92K5fiUNJtSC7wXHXSQfadLPnXsP8s',
    creator_hash: 'EuiqSYWYf6KnUcEmorrTrGQovPKF9a1wSVJAk7bfLgnR',
    asset_hash: 'CcMhrzXFkjyLwZdijjRibgSYw4tUzXYALoCxwms4aMFH',
    tree: 'E7fYCRWkNykc8HNZvEMRj5GuNYSwJ3WjA6HuLsh3YHvL',
    seq: 627605,
    leaf_id: 622994,
  },
  grouping: [
    { group_key: 'collection', group_value: 'DRiP3vrQ7LuvQtmwL74RcejviWmQ1HuuKFcJdUpYG6Di' },
  ],
  royalty: {
    royalty_model: 'creators',
    target: null,
    percent: 0.015,
    basis_points: 150,
    primary_sale_happened: false,
    locked: false,
  },
  creators: [
    { address: 'DRiPPP2LytGjNZ5fVpdZS7Xi1oANSY3Df1gSxvUKpzny', share: 0, verified: true },
    { address: 'WoMbXFtdfH8crq2Zi7bQhfGx2Gv8EN4saP13gcdUGog', share: 100, verified: false },
  ],
  ownership: {
    frozen: false,
    delegated: false,
    delegate: null,
    ownership_model: 'single',
    owner: '5MRNQW3NxNes1EDnxUhqyXwffseQBLpdu6QJF8G4MdN9',
  },
  supply: { print_max_supply: 0, print_current_supply: 0, edition_nonce: null },
  mutable: true,
  burnt: false,
});

const proof = () => ({
  last_indexed_slot: 457714576,
  root: '3wxyaNRvzuZqDd9jtqthCu87spdKuhcpaKVzP1msGyHW',
  proof: [
    '8mjbWMPrBwYJeEmQbeYLR7mscS4umW4U3kxibuH8hcY1',
    'DV31TLc5BXCnCQMaQ9H6empbG9i69w4AWkjR5RPiyXr8',
    'G6f1pEKetujNm6JXQxD47eBudxLV1irR1U5atpAXBb4q',
  ],
  node_index: 1671570,
  leaf: 'CcMhrzXFkjyLwZdijjRibgSYw4tUzXYALoCxwms4aMFH',
  tree_id: 'E7fYCRWkNykc8HNZvEMRj5GuNYSwJ3WjA6HuLsh3YHvL',
});

describe('assets', () => {
  it('getAsset parses a compressed NFT', async () => {
    const bodies = result(dripCnft());
    const asset = await client().getAsset('JEKNNLZK6uQaQUEUz9GRoYZ7buHQ4rTN6k3qhX9NG8qU');

    expect(asset.interface).toBe('V1_NFT');
    expect(asset.last_indexed_slot).toBe(457714576);
    expect(assetName(asset)).toBe('Aurora borealis');
    expect(assetSymbol(asset)).toBeUndefined();
    expect(assetOwner(asset)).toBe('5MRNQW3NxNes1EDnxUhqyXwffseQBLpdu6QJF8G4MdN9');
    expect(assetCollection(asset)).toBe('DRiP3vrQ7LuvQtmwL74RcejviWmQ1HuuKFcJdUpYG6Di');
    expect(assetImage(asset)).toMatch(/^https:\/\/arweave\.net\//);
    expect(isCompressed(asset)).toBe(true);
    expect([asset.compression!.seq, asset.compression!.leaf_id]).toEqual([627605, 622994]);
    expect(asset.content!.metadata!.attributes![1]).toEqual({
      value: 'Common',
      trait_type: 'Rarity',
    });
    expect(asset.royalty!.basis_points).toBe(150);
    expect(asset.royalty!.target).toBeNull();
    expect(asset.creators![1]).toMatchObject({ share: 100, verified: false });
    expect(asset.authorities![0]!.scopes).toEqual(['full']);
    expect(asset.supply!.edition_nonce).toBeNull();

    expect(bodies[0].method).toBe('getAsset');
    expect(bodies[0].params).toEqual({ id: 'JEKNNLZK6uQaQUEUz9GRoYZ7buHQ4rTN6k3qhX9NG8qU' });
  });

  it('getAsset parses the full asset object', async () => {
    result({
      interface: 'ProgrammableNFT',
      id: 'JEGruwYE13mhX2wi2MGrPmeLiVyZtbBptmVy9vG3pXRC',
      content: {
        metadata: {
          name: 'Mad Lads #6867',
          symbol: 'MAD',
          attributes: [{ value: 7, trait_type: 1 }],
        },
      },
      compression: { compressed: false },
      ownership: {
        frozen: true,
        delegated: true,
        delegate: 'FARqKAafAbgT25QcgiX5d1g6xpadgG7xymu5N6gSmp4x',
        ownership_model: 'single',
        owner: 'CxBhuJwhVgNMc7yjnRx3XFAsTnnbYDc2bhAGSaLBjNqZ',
      },
      supply: { print_max_supply: 0, print_current_supply: 0, edition_nonce: 254 },
      token_info: {
        supply: 1,
        decimals: 0,
        token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        associated_token_address: 'J4z9rkXuQFVFYEcE4FnbZrT677Eh6WU3f125wyaDyQXg',
      },
      mpl_core_info: { num_minted: 3, current_size: 3, plugins_json_version: 1 },
    });
    const asset = await client().getAsset('JEGruwYE13mhX2wi2MGrPmeLiVyZtbBptmVy9vG3pXRC');
    expect(asset.interface).toBe('ProgrammableNFT');
    expect(assetSymbol(asset)).toBe('MAD');
    expect(isCompressed(asset)).toBe(false);
    expect(asset.ownership).toMatchObject({ frozen: true, delegated: true });
    expect(asset.supply!.edition_nonce).toBe(254);
    expect(asset.token_info).toMatchObject({ supply: 1, decimals: 0 });
    expect(asset.mpl_core_info!.num_minted).toBe(3);
    expect(asset.content!.metadata!.attributes![0]).toEqual({ value: 7, trait_type: 1 });
  });

  it('helpers tolerate missing and null fields', async () => {
    result({
      interface: 'SomethingNew',
      id: 'x',
      content: { metadata: { name: null } },
      ownership: { owner: null },
      grouping: null,
    });
    const asset = await client().getAsset('x');
    expect(asset.interface).toBe('SomethingNew');
    expect(assetName(asset)).toBeUndefined();
    expect(assetOwner(asset)).toBeUndefined();
    expect(assetCollection(asset)).toBeUndefined();
    expect(isCompressed(asset)).toBe(false);
  });

  it('getAsset sends display options only when set', async () => {
    const bodies = result(dripCnft());
    await client().getAsset('id', {
      showCollectionMetadata: true,
      showUnverifiedCollections: true,
    });
    await client().getAsset('id', {});
    expect(bodies[0].params).toEqual({
      id: 'id',
      options: { showCollectionMetadata: true, showUnverifiedCollections: true },
    });
    expect(bodies[1].params).toEqual({ id: 'id' });
  });
});

/** Answers a batch with an asset per ID, or null for "missing". */
const echoBatch = (body: any) => ({
  jsonrpc: '2.0',
  id: 1,
  result: body.params.ids.map((id: string) =>
    id === 'missing' ? null : { interface: 'V1_NFT', id },
  ),
});

describe('batches', () => {
  it('getAssetBatch keeps order and nulls', async () => {
    const bodies = mock(echoBatch);
    const assets = await client().getAssetBatch(['a', 'missing', 'b']);
    expect(assets.map((a) => a?.id ?? null)).toEqual(['a', null, 'b']);
    expect(bodies[0].method).toBe('getAssetBatch');
  });

  it('getAssetBatch splits into chunks of 1000', async () => {
    const bodies = mock(echoBatch);
    const ids = Array.from({ length: 2500 }, (_, i) => `id${i}`);
    const assets = await client().getAssetBatch(ids);
    expect(assets).toHaveLength(2500);
    expect(assets[2499]!.id).toBe('id2499');
    expect(bodies.map((b) => b.params.ids.length)).toEqual([1000, 1000, 500]);
  });

  it('getAssetBatch with no IDs makes no request', async () => {
    const bodies = mock(echoBatch);
    expect(await client().getAssetBatch([])).toEqual([]);
    expect(bodies).toHaveLength(0);
  });
});

describe('proofs', () => {
  it('getAssetProof and proofPath', async () => {
    const bodies = result(proof());
    const p = await client().getAssetProof('id');
    expect(p.root).toBe('3wxyaNRvzuZqDd9jtqthCu87spdKuhcpaKVzP1msGyHW');
    expect(p.node_index).toBe(1671570);
    expect(proofPath(p)).toHaveLength(3);
    expect(proofPath(p, 1)).toEqual(p.proof.slice(0, 2));
    expect(proofPath(p, 10)).toEqual([]);
    expect(bodies[0].method).toBe('getAssetProof');
  });

  it('getAssetProofBatch maps IDs', async () => {
    const bodies = result({
      JEKNNLZK6uQaQUEUz9GRoYZ7buHQ4rTN6k3qhX9NG8qU: proof(),
      JEGruwYE13mhX2wi2MGrPmeLiVyZtbBptmVy9vG3pXRC: null,
    });
    const proofs = await client().getAssetProofBatch([
      'JEKNNLZK6uQaQUEUz9GRoYZ7buHQ4rTN6k3qhX9NG8qU',
      'JEGruwYE13mhX2wi2MGrPmeLiVyZtbBptmVy9vG3pXRC',
    ]);
    expect(proofs['JEKNNLZK6uQaQUEUz9GRoYZ7buHQ4rTN6k3qhX9NG8qU']!.node_index).toBe(1671570);
    expect(proofs['JEGruwYE13mhX2wi2MGrPmeLiVyZtbBptmVy9vG3pXRC']).toBeNull();
    expect(bodies[0].method).toBe('getAssetProofBatch');
  });

  it('getAssetWithProof returns both', async () => {
    const bodies = result({ asset: dripCnft(), proof: proof() });
    const both = await client().getAssetWithProof('id');
    expect(both.asset.compression!.leaf_id).toBe(622994);
    expect(both.proof.leaf).toBe(both.asset.compression!.asset_hash);
    expect(bodies[0].method).toBe('getAssetWithProof');
  });
});

describe('lists', () => {
  it('getAssetsByOwner parses tokens and native balance', async () => {
    const bodies = result({
      last_indexed_slot: 457714577,
      total: 1,
      limit: 100,
      page: 1,
      nativeBalance: { lamports: 1328527472954, price_per_sol: 101.5, total_price: 134845.54 },
      items: [
        {
          interface: 'FungibleToken',
          id: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          ownership: {
            owner: '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY',
            ownership_model: 'token',
          },
          token_info: {
            symbol: 'USDC',
            balance: 2500000,
            decimals: 6,
            price_info: { price_per_token: 1.0, total_price: 2.5, currency: 'USDC' },
          },
        },
      ],
    });
    const list = await client().getAssetsByOwner({
      ownerAddress: '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY',
      page: 1,
      limit: 100,
      options: { showFungible: true, showNativeBalance: true },
    });
    expect([list.total, list.limit, list.page]).toEqual([1, 100, 1]);
    expect(list.nativeBalance).toMatchObject({ lamports: 1328527472954, price_per_sol: 101.5 });
    expect(list.items[0]!.ownership!.ownership_model).toBe('token');
    expect(list.items[0]!.token_info).toMatchObject({ balance: 2500000, decimals: 6 });
    expect(list.items[0]!.token_info!.price_info!.total_price).toBe(2.5);
    expect(bodies[0].method).toBe('getAssetsByOwner');
    expect(bodies[0].params).toEqual({
      ownerAddress: '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY',
      page: 1,
      limit: 100,
      options: { showFungible: true, showNativeBalance: true },
    });
  });

  it('list requests send the documented params', async () => {
    const bodies = result({ total: 0, limit: 1000, items: [] });
    const c = client();
    await c.getAssetsByGroup({
      groupKey: 'collection',
      groupValue: 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w',
      sortBy: { sortBy: 'recent_action', sortDirection: 'desc' },
      page: 2,
      options: {},
    });
    await c.getAssetsByCreator({ creatorAddress: 'creator', onlyVerified: true, cursor: 'c1' });
    await c.getAssetsByAuthority({ authorityAddress: 'auth', after: 'a', limit: 5 });

    expect(bodies[0].method).toBe('getAssetsByGroup');
    expect(bodies[0].params).toEqual({
      groupKey: 'collection',
      groupValue: 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w',
      sortBy: { sortBy: 'recent_action', sortDirection: 'desc' },
      page: 2,
    });
    expect(bodies[1].method).toBe('getAssetsByCreator');
    expect(bodies[1].params).toEqual({
      creatorAddress: 'creator',
      onlyVerified: true,
      cursor: 'c1',
    });
    expect(bodies[2].method).toBe('getAssetsByAuthority');
    expect(bodies[2].params).toEqual({ authorityAddress: 'auth', after: 'a', limit: 5 });
  });

  it('searchAssets sends filters as given', async () => {
    const bodies = result({ total: 0, limit: 1000, items: [] });
    const req = {
      ownerAddress: '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY',
      grouping: ['collection', 'DRiP3vrQ7LuvQtmwL74RcejviWmQ1HuuKFcJdUpYG6Di'] as [string, string],
      creatorAddress: 'creator',
      creatorVerified: true,
      interface: 'ProgrammableNFT',
      tokenType: 'compressedNFT' as const,
      ownerType: 'single',
      royaltyTargetType: 'fanout',
      royaltyAmount: 500,
      compressed: true,
      burnt: false,
      conditionType: 'any' as const,
      negate: true,
      limit: 10,
    };
    await client().searchAssets(req);
    expect(bodies[0].params).toEqual(req);
  });

  it('getTokenAccounts parses accounts', async () => {
    const bodies = result({
      total: 2,
      limit: 2,
      page: 1,
      token_accounts: [
        {
          address: '1113odRAP5wXa8n7NFVBG53XrqWeDrViZu5rSiSsVA3',
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          owner: 'HJNr4feTNiDn59RCL1pYoARXMFoBEQSmAY7R7Cm21z9T',
          amount: 170812,
          delegate: null,
          delegated_amount: 0,
          close_authority: null,
          frozen: false,
        },
        {
          address: '11NCSQ2Bm6UZdtDqBeHFcos5eFXT1kJ3jG29qKJCWU',
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          owner: 'FRPPBdG4sYCH7EnTMeKFSVLsfzfEUo4PQ1wWCUkzzmuv',
          amount: 1804811,
          delegate: null,
          delegated_amount: 0,
          close_authority: null,
          frozen: true,
          token_extensions: { immutable_owner: true },
        },
      ],
    });
    const list = await client().getTokenAccounts({
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      page: 1,
      limit: 2,
      options: { showZeroBalance: true },
    });
    expect(list.token_accounts).toHaveLength(2);
    expect(list.token_accounts[1]).toMatchObject({ amount: 1804811, frozen: true });
    expect(list.token_accounts[1]!.token_extensions).toBeDefined();
    expect(bodies[0].params).toEqual({
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      page: 1,
      limit: 2,
      options: { showZeroBalance: true },
    });
  });

  it('getTokenAccounts needs an owner or a mint', async () => {
    const bodies = result({});
    const err = await client()
      .getTokenAccounts({})
      .catch((e) => e);
    expect(err).toBeInstanceOf(OrbitflareError);
    expect(err.kind).toBe('config');
    expect(bodies).toHaveLength(0);
  });

  it('getNftEditions parses unlimited supply', async () => {
    const bodies = result({
      total: 2,
      limit: 100,
      page: 1,
      master_edition_address: 'MASTER',
      supply: 2,
      max_supply: null,
      editions: [
        { mint: 'PRINT_MINT_1', edition_address: 'PRINT_EDITION_1', edition: 1 },
        { mint: 'PRINT_MINT_2', edition_address: 'PRINT_EDITION_2', edition: 2 },
      ],
    });
    const editions = await client().getNftEditions({ mint: 'mint', page: 1, limit: 100 });
    expect(editions.supply).toBe(2);
    expect(editions.max_supply).toBeNull();
    expect(editions.editions[1]!.edition).toBe(2);
    expect(bodies[0].params).toEqual({ mint: 'mint', page: 1, limit: 100 });
  });

  it('getSignaturesForAsset turns pairs into objects', async () => {
    const bodies = result({
      last_indexed_slot: 457714577,
      total: 1,
      limit: 100,
      page: 1,
      items: [
        [
          '3eUm7YYq71vcZdgYT3X51xrJeNKaUg5fFfCFaBS2fwP3BPvip2hYxaAaqfNDs3Pj53JPDriQauBtWbz4u7cFN2dw',
          'MintToCollectionV1',
        ],
      ],
    });
    const sigs = await client().getSignaturesForAsset({
      tree: 'tree',
      leafIndex: 622994,
      sortDirection: 'desc',
    });
    expect(sigs.items[0]!.instruction).toBe('MintToCollectionV1');
    expect(sigs.items[0]!.signature).toMatch(/^3eUm7/);
    expect(sigs.page).toBe(1);
    expect(bodies[0].params).toEqual({ tree: 'tree', leafIndex: 622994, sortDirection: 'desc' });
  });

  it('getSignaturesForAsset needs an asset', async () => {
    const err = await client()
      .getSignaturesForAsset({ tree: 'tree' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OrbitflareError);
    expect(err.kind).toBe('config');
  });
});

/** Serves pages of assets with the given sizes, by cursor or by page number. */
const paged = (sizes: number[]) => (body: any) => {
  const p = body.params;
  const index =
    p.page !== undefined ? p.page - 1 : p.cursor ? Number(String(p.cursor).slice(1)) : 0;
  const n = sizes[index] ?? 0;
  const items = Array.from({ length: n }, (_, i) => ({ interface: 'V1_NFT', id: `${index}-${i}` }));
  const r: any = { total: n, limit: p.limit ?? 1000, items };
  if (p.page === undefined) r.cursor = `c${index + 1}`;
  else r.page = p.page;
  return { jsonrpc: '2.0', id: 1, result: r };
};

describe('pages', () => {
  it('walks by cursor until a short page', async () => {
    const bodies = mock(paged([1000, 1000, 3]));
    const items = await client()
      .pages('getAssetsByGroup', { groupKey: 'collection', groupValue: 'col' })
      .collectItems();
    expect(items).toHaveLength(2003);
    expect(items[2002]!.id).toBe('2-2');
    expect(bodies.map((b) => b.params.cursor ?? null)).toEqual([null, 'c1', 'c2']);
    expect(bodies.every((b) => b.params.page === undefined)).toBe(true);
  });

  it('walks by page number when not sorted by id', async () => {
    const bodies = mock(paged([2, 2, 1]));
    const req = {
      ownerAddress: 'owner',
      limit: 2,
      sortBy: { sortBy: 'created' as const, sortDirection: 'desc' as const },
    };
    const seen: [number | undefined, number][] = [];
    for await (const page of client().pages('getAssetsByOwner', req)) {
      seen.push([page.page, page.items.length]);
    }
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
      [3, 1],
    ]);
    expect(bodies.every((b) => b.params.cursor === undefined)).toBe(true);
    expect(req).not.toHaveProperty('page');
  });

  it('stops on an empty page after a full one', async () => {
    const bodies = mock(paged([2, 0]));
    const items = await client()
      .pages('searchAssets', { ownerAddress: 'o', limit: 2 })
      .collectItems();
    expect(items).toHaveLength(2);
    expect(bodies).toHaveLength(2);
  });

  it('signature pages always use page numbers', async () => {
    const bodies = result({ total: 1, limit: 1000, page: 1, items: [['sig', 'Transfer']] });
    const items = await client().pages('getSignaturesForAsset', { id: 'asset' }).collectItems();
    expect(items).toEqual([{ signature: 'sig', instruction: 'Transfer' }]);
    expect(bodies[0].params).toEqual({ id: 'asset', page: 1 });
  });
});

describe('errors', () => {
  it('asset not found is an RPC error and not retried', async () => {
    const bodies = mock(() => ({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'Database Error: RecordNotFound Error: Asset Not Found' },
    }));
    const err = await client(5)
      .getAsset('11111111111111111111111111111111')
      .catch((e) => e);
    expect(err).toBeInstanceOf(OrbitflareError);
    expect(err.kind).toBe('rpc');
    expect(err.rpc.code).toBe(-32000);
    expect(err.message).toContain('Asset Not Found');
    expect(bodies).toHaveLength(1);
  });

  it('invalid params surface the server message', async () => {
    mock(() => ({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Pagination Error. Limit should not be greater than 1000.' },
    }));
    const err = await client()
      .getAssetsByOwner({ ownerAddress: 'o', limit: 5000 })
      .catch((e) => e);
    expect(String(err.message)).toContain('Limit should not be greater than 1000');
  });
});
