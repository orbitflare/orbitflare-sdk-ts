import { readFileSync } from 'node:fs';

import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getSignatureFromTransaction,
  getTransactionEncoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
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
  RpcClientBuilder,
  pickApexTipAccount,
  waitForConfirmation,
} from '@orbitflare/sdk';

async function main() {
  const apex = new ApexClientBuilder().region('fra').build();
  const solana = new RpcClientBuilder()
    .url(process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com')
    .build();

  const keypair = JSON.parse(readFileSync(process.env.KEYPAIR_PATH ?? 'payer.json', 'utf8'));
  const payer = await createKeyPairSignerFromBytes(Uint8Array.from(keypair));
  const to = address(process.env.TO ?? payer.address);

  const tipAccount = pickApexTipAccount(await apex.getTipAccounts());
  const { blockhash, lastValidBlockHeight } = await solana.getLatestBlockhash();

  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash as Blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: 50_000 }),
          getSetComputeUnitPriceInstruction({
            microLamports: APEX_DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
          }),
          getTransferSolInstruction({ source: payer, destination: to, amount: lamports(1_000n) }),
          getTransferSolInstruction({
            source: payer,
            destination: address(tipAccount),
            amount: lamports(BigInt(APEX_MIN_TIP_LAMPORTS)),
          }),
        ],
        m,
      ),
  );
  const tx = await signTransactionMessageWithSigners(message);
  const wire = getTransactionEncoder().encode(tx);

  const sentAt = Date.now();
  const signature = await apex.sendTransactionBinary(wire);
  console.log(`accepted in ${Date.now() - sentAt} ms: ${signature}`);
  console.log(`matches the signed transaction: ${signature === getSignatureFromTransaction(tx)}`);

  const slot = await waitForConfirmation(solana, signature);
  console.log(
    slot === null
      ? 'not confirmed within 30 s'
      : `landed in slot ${slot} after ${Date.now() - sentAt} ms`,
  );
}

void main();
