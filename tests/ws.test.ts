import { describe, expect, it } from 'vitest';

import { OrbitflareError } from '../src/error.js';
import { WsClientBuilder } from '../src/ws.js';

describe('WsClientBuilder', () => {
  it('fails on a dead endpoint', async () => {
    const err = await new WsClientBuilder()
      .url('ws://127.0.0.1:1')
      .retry({ initialDelayMs: 5, maxDelayMs: 20, multiplier: 1.5, maxAttempts: 1 })
      .build()
      .catch((e) => e);
    expect(err).toBeInstanceOf(OrbitflareError);
    expect(err.kind).toBe('transport');
  });
});
