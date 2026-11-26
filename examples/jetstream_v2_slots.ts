import { JetstreamClientBuilder, SlotStatus } from '@orbitflare/sdk/jetstream/v2';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function main() {
  const url = process.env.ORBITFLARE_JETSTREAM_URL ?? 'http://fra.jetstream.orbitflare.com';
  const client = new JetstreamClientBuilder().url(url).build();

  for await (const event of client.subscribeSlotsWithBlockFooters()) {
    if (event.status === SlotStatus.SLOT_STATUS_BLOCK_FOOTER) {
      const footer = event.blockFooter;
      if (!footer) continue;
      console.log(
        `seq=${event.sequence} slot=${footer.slot} FOOTER bank_hash=${hex(footer.bankHash)} block_id=${hex(footer.blockId)} user_agent=${JSON.stringify(Buffer.from(footer.blockUserAgent).toString())} final_cert=${footer.blockFinalCert !== undefined}`,
      );
    } else {
      console.log(
        `seq=${event.sequence} slot=${event.slot} parent=${event.parentSlot} ${SlotStatus[event.status]}`,
      );
    }
  }
}

void main();
