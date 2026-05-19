import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import { OrbitflareError } from './error.js';
import {
  CommitmentLevel,
  type SubscribeRequest as GeyserSubscribeRequest,
  type SubscribeRequestFilterAccounts as GeyserAccountFilter,
  type SubscribeRequestFilterSlots as GeyserSlotFilter,
  type SubscribeRequestFilterTransactions as GeyserTxFilter,
} from './proto/geyser.js';
import {
  type SubscribeRequest as JetstreamSubscribeRequest,
  type SubscribeRequestFilterAccounts as JetAccountFilter,
  type SubscribeRequestFilterTransactions as JetTxFilter,
} from './proto/jetstream.js';

export interface TransactionFilter {
  vote?: boolean;
  failed?: boolean;
  account_include?: string[];
  account_exclude?: string[];
  account_required?: string[];
}

export interface AccountFilter {
  account?: string[];
  owner?: string[];
}

export interface SlotFilter {
  filter_by_commitment?: boolean;
}

export interface GeyserStreamConfig {
  transactions?: Record<string, TransactionFilter>;
  accounts?: Record<string, AccountFilter>;
  slots?: Record<string, SlotFilter>;
  commitment?: string;
}

export interface JetstreamStreamConfig {
  transactions?: Record<string, TransactionFilter>;
  accounts?: Record<string, AccountFilter>;
}

export function loadGeyserConfig(path: string): GeyserStreamConfig {
  return readYaml<GeyserStreamConfig>(path);
}

export function loadJetstreamConfig(path: string): JetstreamStreamConfig {
  return readYaml<JetstreamStreamConfig>(path);
}

function readYaml<T>(path: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e: any) {
    throw OrbitflareError.config(`failed to read ${path}: ${e?.message ?? e}`);
  }
  const expanded = expandEnv(raw);
  try {
    return parseYaml(expanded) as T;
  } catch (e: any) {
    throw OrbitflareError.config(`failed to parse yaml: ${e?.message ?? e}`);
  }
}

function expandEnv(input: string): string {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw OrbitflareError.config(`failed to expand env vars: $${name} not set`);
    }
    return v;
  });
}

function parseCommitment(s?: string): CommitmentLevel {
  switch ((s ?? '').toLowerCase()) {
    case 'processed':
      return CommitmentLevel.PROCESSED;
    case 'finalized':
      return CommitmentLevel.FINALIZED;
    default:
      return CommitmentLevel.CONFIRMED;
  }
}

export function geyserConfigToRequest(cfg: GeyserStreamConfig): GeyserSubscribeRequest {
  const transactions: Record<string, GeyserTxFilter> = {};
  for (const [name, f] of Object.entries(cfg.transactions ?? {})) {
    transactions[name] = {
      vote: f.vote,
      failed: f.failed,
      signature: undefined,
      accountInclude: f.account_include ?? [],
      accountExclude: f.account_exclude ?? [],
      accountRequired: f.account_required ?? [],
    };
  }

  const accounts: Record<string, GeyserAccountFilter> = {};
  for (const [name, f] of Object.entries(cfg.accounts ?? {})) {
    accounts[name] = {
      account: f.account ?? [],
      owner: f.owner ?? [],
      filters: [],
      nonemptyTxnSignature: undefined,
    };
  }

  const slots: Record<string, GeyserSlotFilter> = {};
  for (const [name, f] of Object.entries(cfg.slots ?? {})) {
    slots[name] = {
      filterByCommitment: f.filter_by_commitment,
      interslotUpdates: undefined,
    };
  }

  return {
    accounts,
    slots,
    transactions,
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    commitment: parseCommitment(cfg.commitment),
    accountsDataSlice: [],
    ping: { id: 1 },
    fromSlot: undefined,
  } as GeyserSubscribeRequest;
}

export function jetstreamConfigToRequest(cfg: JetstreamStreamConfig): JetstreamSubscribeRequest {
  const transactions: Record<string, JetTxFilter> = {};
  for (const [name, f] of Object.entries(cfg.transactions ?? {})) {
    transactions[name] = {
      accountInclude: f.account_include ?? [],
      accountExclude: f.account_exclude ?? [],
      accountRequired: f.account_required ?? [],
    };
  }

  const accounts: Record<string, JetAccountFilter> = {};
  for (const [name, f] of Object.entries(cfg.accounts ?? {})) {
    accounts[name] = {
      account: f.account ?? [],
      owner: f.owner ?? [],
      filters: [],
    };
  }

  return {
    transactions,
    accounts,
    ping: { id: 1 },
  } as JetstreamSubscribeRequest;
}
