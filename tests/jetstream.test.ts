import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JetstreamClientBuilder } from '../src/jetstream/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbitflare-jet-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('subscribeYaml', () => {
  it('errors on missing file', () => {
    const client = new JetstreamClientBuilder().url('http://localhost:10000').build();
    expect(() => client.subscribeYaml(join(dir, 'nonexistent.yml'))).toThrow(/failed to read/);
  });

  it('loads a valid config', () => {
    const path = join(dir, 'good.yml');
    writeFileSync(
      path,
      `transactions:
  test:
    account_include:
      - "abc"
`,
    );
    const client = new JetstreamClientBuilder().url('http://localhost:10000').build();
    const stream = client.subscribeYaml(path);
    expect(stream).toBeDefined();
    stream.close();
  });
});

describe('v1 stream against a server', () => {
  it('reports connection events and stops retrying a rejected request', async () => {
    const grpc = await import('@grpc/grpc-js');
    const { JetstreamService } = await import('../src/proto/jetstream.js');
    let connections = 0;
    const server = new grpc.Server();
    server.addService(JetstreamService, {
      subscribe: (call: {
        sendMetadata(m: unknown): void;
        on(e: string, f: () => void): void;
        emit(e: string, v: unknown): void;
      }) => {
        connections += 1;
        call.sendMetadata(new grpc.Metadata());
        call.on('data', () =>
          call.emit('error', { code: grpc.status.PERMISSION_DENIED, details: 'no access' }),
        );
      },
    } as never);
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
        e ? reject(e) : resolve(p),
      ),
    );
    try {
      const stream = new JetstreamClientBuilder()
        .url(`http://127.0.0.1:${port}`)
        .retry({ initialDelayMs: 10, maxDelayMs: 10, multiplier: 2, maxAttempts: 0 })
        .build()
        .subscribe({ transactions: {}, accounts: {} } as never);
      const events = stream.events();
      await expect(stream.next()).rejects.toThrow(/no access/);
      const seen = [];
      for (let e = await events.recv(); e !== undefined; e = await events.recv()) seen.push(e.type);
      expect(seen).toEqual(['connecting', 'connected', 'disconnected']);
      expect(connections).toBe(1);
    } finally {
      server.forceShutdown();
    }
  });
});
