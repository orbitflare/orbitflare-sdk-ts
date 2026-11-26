import { describe, expect, it } from 'vitest';

import { EventHub, endpointLabel } from '../src/events.js';

describe('connection events', () => {
  it('first reader sees events sent before it subscribed', async () => {
    const hub = new EventHub();
    hub.emit({ type: 'connected', endpoint: 'a' });
    const first = hub.subscribe();
    const second = hub.subscribe();
    hub.emit({ type: 'connected', endpoint: 'b' });
    expect(await first.recv()).toEqual({ type: 'connected', endpoint: 'a' });
    expect(await first.recv()).toEqual({ type: 'connected', endpoint: 'b' });
    expect(await second.recv()).toEqual({ type: 'connected', endpoint: 'b' });
  });

  it('slow readers are told what they missed', async () => {
    const hub = new EventHub();
    const events = hub.subscribe();
    for (let i = 0; i < 266; i++) hub.emit({ type: 'connecting', endpoint: 'a', attempt: i });
    expect(await events.recv()).toEqual({ type: 'lagged', missed: 10 });
    expect(await events.recv()).toEqual({ type: 'connecting', endpoint: 'a', attempt: 10 });
  });

  it('ends when the stream is gone', async () => {
    const hub = new EventHub();
    const events = hub.subscribe();
    const pending = events.recv();
    hub.end();
    expect(await pending).toBeUndefined();
    expect(await hub.subscribe().recv()).toBeUndefined();
  });

  it('keeps what was sent before the end', async () => {
    const hub = new EventHub();
    const events = hub.subscribe();
    hub.emit({ type: 'connected', endpoint: 'a' });
    hub.end();
    expect(await events.recv()).toEqual({ type: 'connected', endpoint: 'a' });
    expect(await events.recv()).toBeUndefined();
  });

  it('endpoint labels hide credentials', () => {
    expect(endpointLabel('https://user:pw@ams.rpc.orbitflare.com:10000/?api_key=x')).toBe(
      'https://ams.rpc.orbitflare.com:10000/',
    );
    expect(endpointLabel('http://ams.jetstream.orbitflare.com')).toBe(
      'http://ams.jetstream.orbitflare.com',
    );
  });
});
