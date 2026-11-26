import {
  BlockFooterFilter,
  Commitment,
  GeyserClientBuilder,
  SubscribeRequestBuilder,
} from '@orbitflare/sdk/grpc';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function main() {
  const url = process.env.ORBITFLARE_GRPC_URL ?? 'http://ny.rpc.orbitflare.com:10000';
  const client = new GeyserClientBuilder().url(url).build();

  const request = new SubscribeRequestBuilder()
    .blockFooter('footers', new BlockFooterFilter().includeCertificates(true))
    .commitment(Commitment.Processed)
    .build();
  const stream = client.subscribe(request);

  for await (const update of stream) {
    const f = update.blockFooter;
    if (!f) continue;
    console.log(
      `slot=${f.slot} bank_id=${f.bankId} bank_hash=${hex(f.bankHash)} user_agent=${JSON.stringify(Buffer.from(f.blockUserAgent).toString())} final=${f.blockFinalCert !== undefined} skip=${f.skipRewardCert !== undefined} notar=${f.notarRewardCert !== undefined}`,
    );
  }
}

void main();
