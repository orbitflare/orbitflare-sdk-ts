import { readFileSync } from 'node:fs';

import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getTransactionEncoder,
  lamports,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
  type KeyPairSigner,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { getTransferSolInstruction } from '@solana-program/system';

import {
  APEX_DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  APEX_MIN_TIP_LAMPORTS,
  ApexClientBuilder,
  OrbitflareError,
  RpcClientBuilder,
  apexClientPubkey,
  fetchApexVaults,
  parseApexRegion,
  pickApexTipAccount,
  waitForConfirmation,
  type ApexTransactionBytes,
  type RpcClient,
} from '@orbitflare/sdk';

const env = (name: string, fallback: string) => process.env[name] || fallback;

async function buildTransfer(opts: {
  version: 'legacy' | 1;
  payer: KeyPairSigner;
  to: string;
  amount: bigint;
  tipAccount: string;
  tipLamports: bigint;
  blockhash: { blockhash: string; lastValidBlockHeight: number };
}): Promise<ApexTransactionBytes & { length: number }> {
  const transfer = getTransferSolInstruction({
    source: opts.payer,
    destination: address(opts.to),
    amount: lamports(opts.amount),
  });
  const tip = getTransferSolInstruction({
    source: opts.payer,
    destination: address(opts.tipAccount),
    amount: lamports(opts.tipLamports),
  });
  const lifetime = {
    blockhash: opts.blockhash.blockhash as Blockhash,
    lastValidBlockHeight: BigInt(opts.blockhash.lastValidBlockHeight),
  };
  const signed =
    opts.version === 'legacy'
      ? await signTransactionMessageWithSigners(
          pipe(
            createTransactionMessage({ version: 'legacy' }),
            (m) => setTransactionMessageFeePayerSigner(opts.payer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
            (m) =>
              appendTransactionMessageInstructions(
                [
                  getSetComputeUnitLimitInstruction({ units: 50_000 }),
                  getSetComputeUnitPriceInstruction({
                    microLamports: APEX_DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
                  }),
                  transfer,
                  tip,
                ],
                m,
              ),
          ),
        )
      : await signTransactionMessageWithSigners(
          pipe(
            createTransactionMessage({ version: 1 }),
            (m) => setTransactionMessageFeePayerSigner(opts.payer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
            (m) =>
              setTransactionMessageConfig(
                {
                  computeUnitLimit: 50_000,
                  loadedAccountsDataSizeLimit: 1024 * 1024,
                  priorityFeeLamports: 4_000n,
                },
                m,
              ),
            (m) => appendTransactionMessageInstructions([transfer, tip], m),
          ),
        );
  return getTransactionEncoder().encode(signed);
}

async function report(solana: RpcClient, label: string, signature: string, sentAt: number) {
  const slot = await waitForConfirmation(solana, signature);
  console.log(
    slot === null
      ? `  ${label}: not confirmed within 30 s`
      : `  ${label}: landed in slot ${slot} after ${Date.now() - sentAt} ms  ${signature}`,
  );
}

async function main() {
  const apiKey = process.env.ORBITFLARE_APEX_API_KEY;
  if (!apiKey) throw new Error('ORBITFLARE_APEX_API_KEY is required');
  const region = parseApexRegion(env('ORBITFLARE_APEX_REGION', 'fra'));
  if (!region) throw new Error('unknown ORBITFLARE_APEX_REGION');

  const apex = new ApexClientBuilder().region(region).fallbackRegion('ams').apiKey(apiKey).build();
  const solana = new RpcClientBuilder()
    .url(env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'))
    .build();

  const keypair = JSON.parse(readFileSync(env('KEYPAIR_PATH', 'payer.json'), 'utf8'));
  const payer = await createKeyPairSignerFromBytes(Uint8Array.from(keypair));
  const to = env('TO', payer.address);
  const amount = BigInt(env('LAMPORTS', '1000'));
  const tipLamports = BigInt(env('TIP_LAMPORTS', String(APEX_MIN_TIP_LAMPORTS)));

  console.log(`client pubkey: ${apexClientPubkey(apiKey)} (compare with your dashboard)`);
  await apex.ping();
  console.log(`ping ${region}: ok`);

  const tipAccounts = await apex.getTipAccounts();
  console.log(`tip accounts: ${tipAccounts.length}`);
  const vaults = await fetchApexVaults(solana).catch(() => [] as string[]);
  if (vaults.length > 0) {
    const unpublished = tipAccounts.filter((t) => !vaults.includes(t));
    console.log(
      `vaults on chain: ${vaults.length}, published accounts missing on chain: ${unpublished.length}`,
    );
  }

  const blockhash = await solana.getLatestBlockhash();
  const base = { payer, to, amount, tipLamports, blockhash };

  console.log(`\ntransfers of ${amount} lamports from ${payer.address} to ${to}`);

  const legacy = await buildTransfer({
    ...base,
    version: 'legacy',
    tipAccount: pickApexTipAccount(tipAccounts),
  });
  let sentAt = Date.now();
  const legacySig = await apex.sendTransactionBinary(legacy);
  console.log(`  legacy, ${legacy.length} bytes, /send-bin accepted in ${Date.now() - sentAt} ms`);
  await report(solana, 'legacy', legacySig, sentAt);

  const v1 = await buildTransfer({
    ...base,
    version: 1,
    tipAccount: pickApexTipAccount(tipAccounts),
  });
  sentAt = Date.now();
  const v1Sig = await apex.sendTransaction(v1);
  console.log(`  v1, ${v1.length} bytes, JSON-RPC accepted in ${Date.now() - sentAt} ms`);
  await report(solana, 'v1', v1Sig, sentAt);

  const batch = await Promise.all(
    [1n, 2n].map((extra) =>
      buildTransfer({
        ...base,
        amount: amount + extra,
        version: 'legacy',
        tipAccount: pickApexTipAccount(tipAccounts),
      }),
    ),
  );
  sentAt = Date.now();
  const result = await apex.sendBatch(batch);
  console.log(
    `  batch: ${result.attempted} attempted, ${result.accepted} accepted, ${result.rejected} rejected in ${Date.now() - sentAt} ms`,
  );
  for (const [i, item] of result.results.entries()) {
    if (item.accepted && item.signature) await report(solana, `batch ${i}`, item.signature, sentAt);
    else console.log(`  batch ${i}: rejected ${item.error}: ${item.message}`);
  }

  try {
    await apex.sendTransactionBinary(
      await buildTransfer({
        ...base,
        version: 'legacy',
        tipLamports: 1n,
        tipAccount: pickApexTipAccount(tipAccounts),
      }),
    );
  } catch (e) {
    if (e instanceof OrbitflareError && e.kind === 'apex') {
      console.log(
        `\na tip below the floor is refused before it is sent: ${e.apex?.label}: ${e.apex?.message}`,
      );
    } else {
      throw e;
    }
  }
}

void main();
