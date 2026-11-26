import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GeyserClientBuilder } from '../src/grpc.js';
import { GeyserService, SubscribeRequest, SubscribeUpdate } from '../src/proto/geyser.js';

const BIG = 10 * 1024 * 1024;
let server: grpc.Server;
let url: string;

beforeAll(async () => {
  server = new grpc.Server({ 'grpc.max_send_message_length': -1 });
  server.addService(GeyserService, {
    subscribe: (call: grpc.ServerDuplexStream<SubscribeRequest, SubscribeUpdate>) => {
      call.once('data', () => {
        call.write(
          SubscribeUpdate.fromPartial({
            account: {
              slot: 1n,
              account: { pubkey: new Uint8Array(32), data: new Uint8Array(BIG) },
            },
          }),
        );
      });
    },
  } as never);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  url = `http://127.0.0.1:${port}`;
});

afterAll(() => server.forceShutdown());

const request = () => SubscribeRequest.fromPartial({ accounts: { a: {} } });

describe('message size', () => {
  it('accepts messages over 4 MiB by default', async () => {
    const stream = new GeyserClientBuilder().url(url).build().subscribe(request());
    const update = await stream.next();
    stream.close();
    expect(update?.account?.account?.data.length).toBe(BIG);
  });

  it('rejects messages over a lower configured limit', async () => {
    const stream = new GeyserClientBuilder()
      .url(url)
      .maxDecodingMessageSize(4 * 1024 * 1024)
      .retry({ initialDelayMs: 10, maxDelayMs: 10, multiplier: 2, maxAttempts: 1 })
      .build()
      .subscribe(request());
    await expect(stream.next()).rejects.toMatchObject({
      grpc: { code: grpc.status.RESOURCE_EXHAUSTED },
    });
  });
});
