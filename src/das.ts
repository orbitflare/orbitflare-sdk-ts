// Digital Asset Standard (DAS) API: NFTs, compressed NFTs, MPL Core assets and SPL tokens
// through one set of JSON-RPC methods, served on the same endpoint as standard RPC.

/** Most IDs a batch method takes per request. Larger batches are split automatically. */
export const DAS_MAX_BATCH = 1000;
/** Largest page size, and the server's default. */
export const DAS_MAX_LIMIT = 1000;

/* ---------- Requests ---------- */

/** What a response includes. Every option defaults to off. */
export interface DisplayOptions {
  showFungible?: boolean;
  showNativeBalance?: boolean;
  showZeroBalance?: boolean;
  showUnverifiedCollections?: boolean;
  showCollectionMetadata?: boolean;
  showInscription?: boolean;
}

/** Paging parameters shared by the list methods. Use one of `page`, `cursor`, or `before`/`after`. */
export interface Paging {
  page?: number;
  limit?: number;
  cursor?: string;
  before?: string;
  after?: string;
}

export type AssetSortBy = 'id' | 'created' | 'updated' | 'recent_action' | 'none';
export type SortDirection = 'asc' | 'desc';

export interface SortBy {
  sortBy: AssetSortBy;
  sortDirection?: SortDirection;
}

export type TokenType = 'fungible' | 'nonFungible' | 'regularNFT' | 'compressedNFT' | 'all';
export type ConditionType = 'all' | 'any';

interface AssetListRequest extends Paging {
  sortBy?: SortBy;
  options?: DisplayOptions;
}

export interface GetAssetsByOwnerRequest extends AssetListRequest {
  ownerAddress: string;
}

export interface GetAssetsByGroupRequest extends AssetListRequest {
  /** The group type; use `collection`. */
  groupKey: string;
  groupValue: string;
}

export interface GetAssetsByCreatorRequest extends AssetListRequest {
  creatorAddress: string;
  onlyVerified?: boolean;
}

export interface GetAssetsByAuthorityRequest extends AssetListRequest {
  authorityAddress: string;
}

/** Combines filters in one query. Every filter must match unless `conditionType` is `any`. */
export interface SearchAssetsRequest extends AssetListRequest {
  ownerAddress?: string;
  creatorAddress?: string;
  creatorVerified?: boolean;
  authorityAddress?: string;
  /** Group key and value, such as `['collection', <address>]`. */
  grouping?: [string, string];
  delegate?: string;
  interface?: Interface;
  tokenType?: TokenType;
  ownerType?: OwnershipModel;
  compressed?: boolean;
  compressible?: boolean;
  frozen?: boolean;
  burnt?: boolean;
  supply?: number;
  supplyMint?: string;
  royaltyTargetType?: RoyaltyModel;
  royaltyTarget?: string;
  /** Royalty in basis points. */
  royaltyAmount?: number;
  jsonUri?: string;
  /** Needs `ownerAddress`. */
  name?: string;
  conditionType?: ConditionType;
  negate?: boolean;
}

/** Pass `owner`, `mint` or both. */
export interface GetTokenAccountsRequest extends Paging {
  owner?: string;
  mint?: string;
  options?: Pick<DisplayOptions, 'showZeroBalance'>;
}

export interface GetNftEditionsRequest extends Paging {
  /** The master edition's mint. */
  mint: string;
}

/** Identify the asset by `id`, or by `tree` and `leafIndex` together. Pages by number only. */
export interface GetSignaturesForAssetRequest {
  id?: string;
  tree?: string;
  leafIndex?: number;
  page?: number;
  limit?: number;
  sortDirection?: SortDirection;
}

/* ---------- Responses ---------- */

/** The asset's standard. Unknown values come through as plain strings. */
export type Interface =
  | 'V1_NFT'
  | 'V1_PRINT'
  | 'LEGACY_NFT'
  | 'V2_NFT'
  | 'ProgrammableNFT'
  | 'FungibleAsset'
  | 'FungibleToken'
  | 'MplCoreAsset'
  | 'MplCoreCollection'
  | 'MplCoreGroup'
  | 'MplBubblegumV2'
  | 'Identity'
  | 'Executable'
  | 'Custom'
  | (string & {});

/** `single` for NFTs, `token` for fungible tokens. */
export type OwnershipModel = 'single' | 'token' | (string & {});
export type RoyaltyModel = 'creators' | 'fanout' | 'single' | (string & {});
export type Scope = 'full' | 'royalty' | 'metadata' | 'extension' | (string & {});

export interface Asset {
  interface: Interface;
  id: string;
  last_indexed_slot?: number;
  content?: Content;
  authorities?: Authority[];
  compression?: Compression;
  grouping?: Group[];
  royalty?: Royalty;
  creators?: Creator[];
  ownership?: Ownership;
  supply?: Supply | null;
  mutable?: boolean;
  burnt?: boolean;
  token_info?: TokenInfo;
  /** Token-2022 mint extensions. */
  mint_extensions?: Record<string, unknown>;
  inscription?: Record<string, unknown>;
  /** MPL Core plugins. */
  plugins?: Record<string, unknown>;
  unknown_plugins?: unknown;
  external_plugins?: unknown;
  unknown_external_plugins?: unknown;
  mpl_core_info?: MplCoreInfo;
  uses?: Uses;
}

export interface Content {
  $schema?: string;
  json_uri?: string;
  files?: AssetFile[];
  metadata?: Metadata;
  links?: Links;
  category?: string;
}

export interface AssetFile {
  uri?: string;
  cdn_uri?: string;
  mime?: string;
  quality?: unknown;
  contexts?: string[];
}

export interface Metadata {
  name?: string;
  symbol?: string;
  description?: string;
  attributes?: Attribute[];
  token_standard?: string;
  /** The name in the off-chain JSON. */
  json_name?: string;
}

/** Hand-written metadata, so either field can be any JSON value. */
export interface Attribute {
  trait_type?: unknown;
  value?: unknown;
}

export interface Links {
  image?: string;
  animation_url?: string;
  external_url?: string;
  [key: string]: unknown;
}

export interface Authority {
  address: string;
  scopes?: Scope[];
}

export interface Compression {
  eligible: boolean;
  compressed: boolean;
  data_hash: string;
  creator_hash: string;
  asset_hash: string;
  tree: string;
  seq: number;
  leaf_id: number;
  /** Bubblegum v2 only. */
  collection_hash?: string;
  /** Bubblegum v2 only. */
  asset_data_hash?: string;
  /** Bubblegum v2 only. */
  flags?: number;
}

export interface Group {
  group_key: string;
  group_value?: string | null;
  /** `false` on unverified collections, which appear only with `showUnverifiedCollections`. */
  verified?: boolean;
  /** With `showCollectionMetadata`. */
  collection_metadata?: Record<string, unknown>;
}

export interface Royalty {
  royalty_model: RoyaltyModel;
  target: string | null;
  percent: number;
  basis_points: number;
  primary_sale_happened: boolean;
  locked: boolean;
}

export interface Creator {
  address: string;
  /** Percent of royalties. */
  share: number;
  verified: boolean;
}

export interface Ownership {
  /** Empty for fungible tokens. */
  owner: string;
  ownership_model: OwnershipModel;
  frozen: boolean;
  delegated: boolean;
  delegate: string | null;
  non_transferable?: boolean;
}

export interface Supply {
  print_max_supply?: number | null;
  print_current_supply?: number | null;
  edition_nonce?: number | null;
  /** Prints only. */
  edition_number?: number;
  /** Prints only. */
  master_edition_mint?: string;
}

export interface TokenInfo {
  symbol?: string;
  /** The queried owner's balance, in base units. */
  balance?: number;
  /** Total supply, in base units. */
  supply?: number;
  decimals?: number;
  token_program?: string;
  associated_token_address?: string;
  mint_authority?: string;
  freeze_authority?: string;
  price_info?: PriceInfo;
}

export interface PriceInfo {
  price_per_token: number;
  /** Value of the owner's balance. */
  total_price?: number;
  currency: string;
}

export interface MplCoreInfo {
  num_minted?: number;
  current_size?: number;
  plugins_json_version?: number;
}

export interface Uses {
  use_method: string;
  remaining: number;
  total: number;
}

/** The owner's SOL balance, with `showNativeBalance`. */
export interface NativeBalance {
  lamports: number;
  price_per_sol?: number;
  /** In USD. */
  total_price?: number;
}

export interface AssetProof {
  root: string;
  /** Sibling hashes from the leaf up to the root. */
  proof: string[];
  node_index: number;
  leaf: string;
  tree_id: string;
  last_indexed_slot?: number;
}

export interface AssetWithProof {
  asset: Asset;
  proof: AssetProof;
}

export interface AssetList {
  last_indexed_slot?: number;
  /** Items in this page. */
  total: number;
  limit: number;
  page?: number;
  cursor?: string;
  before?: string;
  after?: string;
  items: Asset[];
  nativeBalance?: NativeBalance;
}

export interface TokenAccount {
  address: string;
  mint: string;
  owner: string;
  /** In base units. */
  amount: number;
  delegate: string | null;
  delegated_amount: number;
  close_authority: string | null;
  frozen: boolean;
  /** Token-2022 account extensions. */
  token_extensions?: Record<string, unknown>;
}

export interface TokenAccountList {
  last_indexed_slot?: number;
  total: number;
  limit: number;
  page?: number;
  cursor?: string;
  token_accounts: TokenAccount[];
}

export interface NftEdition {
  mint: string;
  edition_address: string;
  edition: number;
}

export interface NftEditions {
  master_edition_address: string;
  /** Editions printed so far. */
  supply: number;
  /** `null` when unlimited. */
  max_supply: number | null;
  total: number;
  limit: number;
  page?: number;
  cursor?: string;
  editions: NftEdition[];
}

/** A transaction that changed a compressed asset. */
export interface AssetSignature {
  signature: string;
  /** The Bubblegum instruction, such as `MintToCollectionV1`, `Transfer` or `Burn`. */
  instruction: string;
}

export interface AssetSignatures {
  last_indexed_slot?: number;
  total: number;
  limit: number;
  page?: number;
  items: AssetSignature[];
}

/* ---------- Helpers ---------- */

export function assetName(asset: Asset): string | undefined {
  return asset.content?.metadata?.name || undefined;
}

export function assetSymbol(asset: Asset): string | undefined {
  return asset.content?.metadata?.symbol || undefined;
}

export function assetImage(asset: Asset): string | undefined {
  return asset.content?.links?.image || undefined;
}

/** The owner, or `undefined` for fungible tokens, which have many holders. */
export function assetOwner(asset: Asset): string | undefined {
  return asset.ownership?.owner || undefined;
}

/** The collection address, if the asset is in a collection. */
export function assetCollection(asset: Asset): string | undefined {
  return asset.grouping?.find((g) => g.group_key === 'collection')?.group_value ?? undefined;
}

export function isCompressed(asset: Asset): boolean {
  return asset.compression?.compressed === true;
}

/**
 * The proof nodes a transaction must pass, leaving out the `canopyDepth` top levels the tree
 * already stores on chain.
 */
export function proofPath(proof: AssetProof, canopyDepth = 0): string[] {
  return proof.proof.slice(0, Math.max(0, proof.proof.length - canopyDepth));
}

/* ---------- Paging ---------- */

/** The list methods that [`RpcClient.pages`] can walk, with their requests and pages. */
export interface PagedMethods {
  getAssetsByOwner: { request: GetAssetsByOwnerRequest; page: AssetList; item: Asset };
  getAssetsByGroup: { request: GetAssetsByGroupRequest; page: AssetList; item: Asset };
  getAssetsByCreator: { request: GetAssetsByCreatorRequest; page: AssetList; item: Asset };
  getAssetsByAuthority: { request: GetAssetsByAuthorityRequest; page: AssetList; item: Asset };
  searchAssets: { request: SearchAssetsRequest; page: AssetList; item: Asset };
  getTokenAccounts: {
    request: GetTokenAccountsRequest;
    page: TokenAccountList;
    item: TokenAccount;
  };
  getNftEditions: { request: GetNftEditionsRequest; page: NftEditions; item: NftEdition };
  getSignaturesForAsset: {
    request: GetSignaturesForAssetRequest;
    page: AssetSignatures;
    item: AssetSignature;
  };
}

export type PagedMethod = keyof PagedMethods;

export function pageItems<M extends PagedMethod>(
  page: PagedMethods[M]['page'],
): PagedMethods[M]['item'][] {
  const p = page as any;
  return (p.items ?? p.token_accounts ?? p.editions ?? []) as PagedMethods[M]['item'][];
}

/**
 * Pages of a list request. Requests sorted by `id` page by cursor; other sorts, requests that
 * set `page`, and `getSignaturesForAsset` page by number. Iterate it with `for await`, or call
 * `collectItems()`.
 */
export class Pages<M extends PagedMethod> implements AsyncIterable<PagedMethods[M]['page']> {
  private readonly req: Record<string, any>;
  private done = false;

  constructor(
    private readonly method: M,
    request: PagedMethods[M]['request'],
    private readonly fetchPage: (
      method: M,
      req: PagedMethods[M]['request'],
    ) => Promise<PagedMethods[M]['page']>,
  ) {
    this.req = { ...request };
    const sortedById = !this.req.sortBy || this.req.sortBy.sortBy === 'id';
    if ((method === 'getSignaturesForAsset' || !sortedById) && this.req.page === undefined) {
      this.req.page = 1;
    }
  }

  /** The next page, or `undefined` once there are no more. */
  async nextPage(): Promise<PagedMethods[M]['page'] | undefined> {
    if (this.done) return undefined;
    let page: PagedMethods[M]['page'];
    try {
      page = await this.fetchPage(this.method, { ...this.req } as PagedMethods[M]['request']);
    } catch (e) {
      this.done = true;
      throw e;
    }
    const count = pageItems<M>(page).length;
    const full = count >= (this.req.limit ?? DAS_MAX_LIMIT);
    const cursor = (page as { cursor?: string }).cursor;
    if (!full || count === 0) {
      this.done = true;
    } else if (this.req.page !== undefined) {
      this.req.page += 1;
    } else if (this.req.before !== undefined || this.req.after !== undefined) {
      // A range is one slice, not a walk.
      this.done = true;
    } else if (cursor) {
      this.req.cursor = cursor;
    } else {
      this.done = true;
    }
    return page;
  }

  /** Every item on every remaining page. */
  async collectItems(): Promise<PagedMethods[M]['item'][]> {
    const items: PagedMethods[M]['item'][] = [];
    for await (const page of this) items.push(...pageItems<M>(page));
    return items;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<PagedMethods[M]['page']> {
    for (let page = await this.nextPage(); page !== undefined; page = await this.nextPage()) {
      yield page;
    }
  }
}

/** Adds `options` only when at least one is set, like the other SDKs. */
export function withOptions<T extends object>(params: T, options?: DisplayOptions): T {
  if (!options || Object.values(options).every((v) => v === undefined)) {
    const rest = { ...params } as Record<string, unknown>;
    delete rest.options;
    return rest as T;
  }
  return { ...params, options };
}
