import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OrbitflareError } from '../src/error.js';
import { GeyserClientBuilder } from '../src/grpc.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbitflare-grpc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('subscribeYaml', () => {
  it('errors on missing file', () => {
    const client = new GeyserClientBuilder().url('http://localhost:10000').build();
    expect(() => client.subscribeYaml(join(dir, 'nonexistent.yml'))).toThrow(/failed to read/);
  });

  it('errors on invalid yaml', () => {
    const path = join(dir, 'bad.yml');
    writeFileSync(path, ':\n  - one\n - two');
    const client = new GeyserClientBuilder().url('http://localhost:10000').build();
    expect(() => client.subscribeYaml(path)).toThrow(OrbitflareError);
  });

  it('loads a valid config', () => {
    const path = join(dir, 'good.yml');
    writeFileSync(
      path,
      `transactions:
  test:
    account_include:
      - "abc"
commitment: confirmed
`,
    );
    const client = new GeyserClientBuilder().url('http://localhost:10000').build();
    const stream = client.subscribeYaml(path);
    expect(stream).toBeDefined();
    stream.close();
  });
});
