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
