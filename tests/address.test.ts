import { describe, expect, it } from 'vitest';

import { parseAddress } from '../src/address.js';

describe('parseAddress', () => {
  it('appends :80 to http URLs without a port', () => {
    expect(parseAddress('http://ams.jetstream.orbitflare.com').target).toBe(
      'ams.jetstream.orbitflare.com:80',
    );
  });

  it('appends :443 to https URLs without a port', () => {
    expect(parseAddress('https://ams.jetstream.orbitflare.com').target).toBe(
      'ams.jetstream.orbitflare.com:443',
    );
  });

  it('keeps an explicit port', () => {
    expect(parseAddress('http://ams.rpc.orbitflare.com:10000').target).toBe(
      'ams.rpc.orbitflare.com:10000',
    );
  });

  it('strips a trailing path', () => {
    expect(parseAddress('http://host/v1/yellowstone').target).toBe('host:80');
  });

  it('keeps an https port other than 443', () => {
    expect(parseAddress('https://host:8443').target).toBe('host:8443');
  });
});
