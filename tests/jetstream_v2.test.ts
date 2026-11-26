import { describe, expect, it } from 'vitest';

import { OrbitflareError } from '../src/error.js';
import { JetstreamClient, JetstreamClientBuilder, TransactionFilter } from '../src/jetstream/v2.js';

describe('v2 TransactionFilter', () => {
  it('builds a TxFilter via withId', () => {
    const filter = new TransactionFilter()
      .accountInclude(['acc1'])
      .accountExclude(['acc2'])
      .accountRequired(['acc3'])
      .includeEnrichment(true)
      .withId('my-filter');

    expect(filter).toEqual({
      filterId: 'my-filter',
      filter: {
        accountInclude: ['acc1'],
        accountExclude: ['acc2'],
        accountRequired: ['acc3'],
        includeEnrichment: true,
      },
    });
  });

  it('defaults includeEnrichment to false', () => {
    const filter = new TransactionFilter().accountInclude(['acc1']).withId('f');
    expect(filter.filter?.includeEnrichment).toBe(false);
  });
});

describe('v2 JetstreamClient.filter', () => {
  it('builds a TxFilter from an account-include list', () => {
    expect(JetstreamClient.filter('f', ['acc1'])).toEqual({
      filterId: 'f',
      filter: {
        accountInclude: ['acc1'],
        accountExclude: [],
        accountRequired: [],
        includeEnrichment: false,
      },
    });
  });
});

describe('v2 JetstreamClientBuilder', () => {
  it('requires a URL', () => {
    const prev = process.env.ORBITFLARE_JETSTREAM_URL;
    delete process.env.ORBITFLARE_JETSTREAM_URL;
    try {
      expect(() => new JetstreamClientBuilder().build()).toThrow(OrbitflareError);
    } finally {
      if (prev !== undefined) process.env.ORBITFLARE_JETSTREAM_URL = prev;
    }
  });

  it('builds a client and opens streams', () => {
    const client = new JetstreamClientBuilder().url('http://localhost:10000').build();
    const filter = JetstreamClient.filter('f', ['acc1']);
    const txStream = client.subscribeTransactions([filter]);
    expect(txStream).toBeDefined();
    txStream.close();

    const slotStream = client.subscribeSlots();
    expect(slotStream).toBeDefined();
    slotStream.close();
  });

  it('exposes a runtime filter handle', () => {
    const client = new JetstreamClientBuilder().url('http://localhost:10000').build();
    const stream = client.subscribeTransactions([]);
    const handle = stream.handle();
    expect(() => handle.addFilters([JetstreamClient.filter('f', ['acc1'])])).not.toThrow();
    expect(() => handle.removeFilters(['f'])).not.toThrow();
    expect(() => handle.ping(1)).not.toThrow();
    stream.close();
  });
});

describe('v2 api key', () => {
  async function versionServer(seen: (string | undefined)[]) {
    const grpc = await import('@grpc/grpc-js');
    const { JetstreamV2Service } = await import('../src/proto/jetstream_v2.js');
    const server = new grpc.Server();
    server.addService(JetstreamV2Service, {
      getVersion: (
        call: { metadata: { get(k: string): unknown[] } },
        cb: (e: null, r: { version: string }) => void,
      ) => {
        seen.push(call.metadata.get('x-token')[0] as string | undefined);
        cb(null, { version: 'test' });
      },
    } as never);
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
        e ? reject(e) : resolve(p),
      ),
    );
    return { server, url: `http://127.0.0.1:${port}` };
  }

  it('sends the key as x-token', async () => {
    const seen: (string | undefined)[] = [];
    const { server, url } = await versionServer(seen);
    try {
      await new JetstreamClientBuilder().url(url).apiKey('ORBIT-123').build().getVersion();
      expect(seen).toEqual(['ORBIT-123']);
    } finally {
      server.forceShutdown();
    }
  });

  it('sends no x-token without a key', async () => {
    const saved = process.env.ORBITFLARE_LICENSE_KEY;
    delete process.env.ORBITFLARE_LICENSE_KEY;
    const seen: (string | undefined)[] = [];
    const { server, url } = await versionServer(seen);
    try {
      await new JetstreamClientBuilder().url(url).build().getVersion();
      expect(seen).toEqual([undefined]);
    } finally {
      server.forceShutdown();
      if (saved !== undefined) process.env.ORBITFLARE_LICENSE_KEY = saved;
    }
  });
});

describe('v2 streams against a server', () => {
  async function v2Server(handlers: Record<string, unknown>) {
    const grpc = await import('@grpc/grpc-js');
    const { JetstreamV2Service } = await import('../src/proto/jetstream_v2.js');
    const server = new grpc.Server();
    server.addService(JetstreamV2Service, handlers as never);
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
        e ? reject(e) : resolve(p),
      ),
    );
    return { server, url: `http://127.0.0.1:${port}`, grpc };
  }

  const fast = { initialDelayMs: 10, maxDelayMs: 10, multiplier: 2, maxAttempts: 0 };

  it('asks for block footers only when opted in', async () => {
    const seen: boolean[] = [];
    const { server, url } = await v2Server({
      subscribeSlots: (call: {
        request: { includeBlockFooter: boolean };
        write(v: unknown): void;
        end(): void;
      }) => {
        seen.push(call.request.includeBlockFooter);
        call.write({
          slot: 1n,
          status: 4,
          currentLeader: new Uint8Array(),
          parentSlot: 0n,
          sequence: 1n,
        });
      },
    });
    try {
      const client = new JetstreamClientBuilder().url(url).build();
      const plain = client.subscribeSlots();
      await plain.next();
      plain.close();
      const footers = client.subscribeSlotsWithBlockFooters();
      const event = await footers.next();
      footers.close();
      expect(seen).toEqual([false, true]);
      expect(event?.slot).toBe(1n);
    } finally {
      server.forceShutdown();
    }
  });

  it('report connection events and stop retrying a rejected request', async () => {
    let connections = 0;
    const { server, url, grpc } = await v2Server({
      subscribeTransactions: (call: {
        sendMetadata(m: unknown): void;
        on(e: string, f: () => void): void;
        emit(e: string, v: unknown): void;
      }) => {
        connections += 1;
        call.sendMetadata(new grpc.Metadata());
        call.on('data', () =>
          call.emit('error', { code: grpc.status.INVALID_ARGUMENT, details: 'bad filter' }),
        );
      },
    });
    try {
      const stream = new JetstreamClientBuilder()
        .url(url)
        .retry(fast)
        .build()
        .subscribeTransactions([JetstreamClient.filter('f', ['acc1'])]);
      const events = stream.events();
      await expect(stream.next()).rejects.toThrow(/bad filter/);
      expect(await stream.next()).toBeUndefined();
      const seen = [];
      for (let e = await events.recv(); e !== undefined; e = await events.recv()) seen.push(e);
      expect(seen.map((e) => e.type)).toEqual(['connecting', 'connected', 'disconnected']);
      expect(seen[0]).toMatchObject({ endpoint: url, attempt: 1 });
      expect(seen[2]).not.toHaveProperty('retryInMs');
      expect(connections).toBe(1);
    } finally {
      server.forceShutdown();
    }
  });
});
