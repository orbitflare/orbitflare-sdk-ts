import { describe, expect, it } from 'vitest';

import { applyApiKey } from '../src/credentials.js';

describe('applyApiKey', () => {
  it('appends key when host has no path', () => {
    expect(applyApiKey('http://fra.rpc.orbitflare.com', 'ORBIT-123')).toBe(
      'http://fra.rpc.orbitflare.com/?api_key=ORBIT-123',
    );
  });

  it('preserves existing path', () => {
    expect(applyApiKey('http://fra.rpc.orbitflare.com/v1', 'ORBIT-123')).toBe(
      'http://fra.rpc.orbitflare.com/v1?api_key=ORBIT-123',
    );
  });

  it('appends with existing query', () => {
    expect(applyApiKey('http://fra.rpc.orbitflare.com?foo=bar', 'ORBIT-123')).toBe(
      'http://fra.rpc.orbitflare.com?foo=bar&api_key=ORBIT-123',
    );
  });

  it('skips if api_key already present', () => {
    const url = 'http://fra.rpc.orbitflare.com?api_key=ORBIT-ABC';
    expect(applyApiKey(url, 'ORBIT-123')).toBe(url);
  });

  it('skips if key is empty', () => {
    const url = 'http://fra.rpc.orbitflare.com';
    expect(applyApiKey(url, '')).toBe(url);
  });
});
