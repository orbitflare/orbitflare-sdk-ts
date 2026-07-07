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
