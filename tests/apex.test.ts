import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

import {
  APEX_MAX_TRANSACTION_SIZE,
  APEX_REGIONS,
  ApexClientBuilder,
  apexClientPubkey,
  apexUrl,
  encodeApexFrames,
  fetchApexVaults,
  parseApexRegion,
  pickApexTipAccount,
  waitForConfirmation,
} from '../src/apex.js';
import { OrbitflareError, sanitizeUrl } from '../src/error.js';
import { RpcClientBuilder } from '../src/rpc.js';

const ORIGIN = 'http://apex.test';
const ORIGIN_DOWN = 'http://apex.down';
const SOLANA = 'http://solana.test';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface Seen {
  url: URL;
  method: string;
  apiKey: string | null;
  contentType: string | null;
  json?: any;
  bytes?: Uint8Array;
}

const captured: Seen[] = [];

const record = async (request: Request): Promise<Seen> => {
  const seen: Seen = {
    url: new URL(request.url),
    method: request.method,
    apiKey: request.headers.get('x-api-key'),
    contentType: request.headers.get('content-type'),
  };
  if (request.method === 'POST') {
    if (seen.contentType?.includes('json')) seen.json = await request.json();
    else seen.bytes = new Uint8Array(await request.arrayBuffer());
  }
  captured.push(seen);
  return seen;
};

const last = () => captured[captured.length - 1]!;

const client = (url = ORIGIN, fallbacks: string[] = []) => {
  let b = new ApexClientBuilder().url(url).apiKey('apex_test');
  for (const f of fallbacks) b = b.fallbackUrl(f);
  return b.build();
};

describe('regions and helpers', () => {
  it('maps every region to its host and parses codes and city names', () => {
    for (const r of APEX_REGIONS) expect(parseApexRegion(r)).toBe(r);
    expect(parseApexRegion('Dublin')).toBe('dub');
    expect(parseApexRegion('new-york')).toBe('nyc');
    expect(parseApexRegion('mumbai')).toBeUndefined();
    expect(apexUrl('tyo')).toBe('http://tyo.apex.orbitflare.com');
  });

  it('derives the client pubkey the server expects', () => {
    expect(apexClientPubkey('test-api-key')).toBe('2ovF9aU8fszHXpZwxaC1S9NF2m5VVDRBUvDUVQvXs4Tv');
  });

  it('frames batches as big-endian length prefixed transactions', () => {
    expect([...encodeApexFrames([Uint8Array.from([1, 2, 3]), Uint8Array.from([9])])]).toEqual([
      0, 3, 1, 2, 3, 0, 1, 9,
    ]);
    expect(() => encodeApexFrames([new Uint8Array(0)])).toThrow(OrbitflareError);
    expect(() => encodeApexFrames([new Uint8Array(APEX_MAX_TRANSACTION_SIZE + 1)])).toThrow();
  });

  it('picks a tip account and refuses an empty list', () => {
    expect(pickApexTipAccount(['APeX2oLtjYehgTMUCA971L8htM7tGNqsXHDz5NrivhhX'])).toBe(
      'APeX2oLtjYehgTMUCA971L8htM7tGNqsXHDz5NrivhhX',
    );
    expect(() => pickApexTipAccount([])).toThrow(OrbitflareError);
  });

  it('removes Apex keys from logged URLs', () => {
    expect(sanitizeUrl('http://fra.apex.orbitflare.com?api-key=apex_secret')).toBe(
      'http://fra.apex.orbitflare.com',
    );
  });

  it('requires an API key', () => {
    const prev = process.env.ORBITFLARE_APEX_API_KEY;
    delete process.env.ORBITFLARE_APEX_API_KEY;
    expect(() => new ApexClientBuilder().build()).toThrow(/no Apex API key/);
    process.env.ORBITFLARE_APEX_API_KEY = prev ?? '';
    if (prev === undefined) delete process.env.ORBITFLARE_APEX_API_KEY;
  });
});

describe('JSON-RPC', () => {
  it('gets the tip accounts with the key in the x-api-key header', async () => {
    server.use(
      http.post(ORIGIN, async ({ request }) => {
        await record(request);
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: 1,
          result: ['APeX2oLtjYehgTMUCA971L8htM7tGNqsXHDz5NrivhhX', 7],
        });
      }),
    );
    expect(await client().getTipAccounts()).toEqual([
      'APeX2oLtjYehgTMUCA971L8htM7tGNqsXHDz5NrivhhX',
    ]);
    expect(last().apiKey).toBe('apex_test');
    expect(last().json.method).toBe('getTipAccounts');
    expect(last().url.search).toBe('');
  });

  it('sends a transaction as base64 with mev and retry options', async () => {
    server.use(
      http.post(ORIGIN, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: '5sig' });
      }),
    );
    const c = new ApexClientBuilder()
      .url(ORIGIN)
      .apiKey('k')
      .mevProtect(true)
      .maxRetries(3)
      .build();
    expect(await c.sendTransaction(Uint8Array.from([1, 2, 3]))).toBe('5sig');
    expect(last().json.params).toEqual(['AQID', { encoding: 'base64', maxRetries: 3 }, true]);
    await c.sendTransaction('AQID', { mevProtect: false });
    expect(last().json.params[2]).toBe(false);
  });

  it('turns a JSON-RPC error into an rpc error with its code', async () => {
    server.use(
      http.post(ORIGIN, () =>
        HttpResponse.json(
          { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'no tip' } },
          { status: 400 },
        ),
      ),
    );
    const err = await client()
      .sendTransaction(Uint8Array.from([1]))
      .catch((e) => e);
    expect(err).toBeInstanceOf(OrbitflareError);
    expect(err.kind).toBe('rpc');
    expect(err.rpc.code).toBe(-32602);
  });
});

describe('binary routes', () => {
  it('posts raw bytes to /send-bin with the flags in the query', async () => {
    server.use(
      http.post(`${ORIGIN}/send-bin`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ signature: '3abc' });
      }),
    );
    const sig = await client().sendTransactionBinary(Uint8Array.from([0xaa, 0x01]), {
      mevProtect: true,
      maxRetries: 2,
    });
    expect(sig).toBe('3abc');
    expect(last().url.search).toBe('?mev_protect=1&max_retries=2');
    expect(last().contentType).toBe('application/octet-stream');
    expect([...last().bytes!]).toEqual([0xaa, 0x01]);
  });

  it('surfaces the rejection label and message as an apex error', async () => {
    server.use(
      http.post(`${ORIGIN}/send-bin`, () =>
        HttpResponse.json(
          { error: 'below_floor', message: 'tip 1000 below floor 1000000' },
          { status: 400 },
        ),
      ),
    );
    const err = await client()
      .sendTransactionBinary(Uint8Array.from([1]))
      .catch((e) => e);
    expect(err.kind).toBe('apex');
    expect(err.apex).toEqual({
      status: 400,
      label: 'below_floor',
      message: 'tip 1000 below floor 1000000',
    });
    expect(err.isRetryable()).toBe(false);
  });

  it('reports 429 as rate limited with the Retry-After delay', async () => {
    server.use(
      http.post(
        `${ORIGIN}/send-bin`,
        () => new HttpResponse('{}', { status: 429, headers: { 'retry-after': '2' } }),
      ),
    );
    const err = await client()
      .sendTransactionBinary(Uint8Array.from([1]))
      .catch((e) => e);
    expect(err.kind).toBe('rateLimited');
    expect(err.retryAfter()).toBe(2000);
  });

  it('refuses empty and oversized transactions locally', async () => {
    const c = client();
    await expect(c.sendTransactionBinary(new Uint8Array(0))).rejects.toThrow(OrbitflareError);
    await expect(
      c.sendTransactionBinary(new Uint8Array(APEX_MAX_TRANSACTION_SIZE + 1)),
    ).rejects.toThrow(/outside/);
  });

  it('sends a batch and maps every result', async () => {
    server.use(
      http.post(`${ORIGIN}/send-batch`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({
          attempted: 2,
          accepted: 1,
          rejected: 1,
          results: [{ signature: 's1' }, { error: 'no_tip', message: 'missing tip' }],
        });
      }),
    );
    const res = await client().sendBatch([Uint8Array.from([1, 2]), Uint8Array.from([3])]);
    expect(res).toEqual({
      attempted: 2,
      accepted: 1,
      rejected: 1,
      results: [
        { accepted: true, signature: 's1' },
        { accepted: false, error: 'no_tip', message: 'missing tip' },
      ],
    });
    expect([...last().bytes!]).toEqual([0, 2, 1, 2, 0, 1, 3]);
    await expect(client().sendBatch([])).rejects.toThrow(/1\.\.16/);
  });

  it('sends a bundle and reads its statuses', async () => {
    server.use(
      http.post(`${ORIGIN}/send-bundle`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ bundle_id: 'b1', signatures: ['x', 'y'] });
      }),
      http.post(ORIGIN, async ({ request }) => {
        await record(request);
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: 1,
          result: {
            value: [
              { bundle_id: 'b1', status: 'Landed', landed_slot: 42 },
              { bundle_id: 'b2', status: 'Pending', landed_slot: null },
              { bundle_id: 'b3', status: 'Weird' },
            ],
          },
        });
      }),
    );
    const c = client();
    expect(await c.sendBundle([Uint8Array.from([1]), Uint8Array.from([2, 3])])).toEqual({
      bundleId: 'b1',
      signatures: ['x', 'y'],
    });
    expect(captured.at(-1)!.url.pathname).toBe('/send-bundle');
    expect(await c.getBundleStatuses(['b1', 'b2', 'b3'])).toEqual([
      { bundleId: 'b1', state: 'Landed', landedSlot: 42 },
      { bundleId: 'b2', state: 'Pending', landedSlot: null },
      { bundleId: 'b3', state: 'Invalid', landedSlot: null },
    ]);
    expect(last().json.params).toEqual([['b1', 'b2', 'b3']]);
    await expect(c.sendBundle(new Array(5).fill(Uint8Array.from([1])))).rejects.toThrow(/1\.\.4/);
  });

  it('pings without a key', async () => {
    server.use(
      http.get(`${ORIGIN}/ping`, async ({ request }) => {
        await record(request);
        return new HttpResponse('pong');
      }),
    );
    await client().ping();
    expect(last().method).toBe('GET');
  });

  it('fails over to the next endpoint when one is unreachable', async () => {
    server.use(
      http.post(`${ORIGIN_DOWN}/send-bin`, () => HttpResponse.error()),
      http.post(`${ORIGIN}/send-bin`, () => HttpResponse.json({ signature: 'from-fallback' })),
    );
    expect(await client(ORIGIN_DOWN, [ORIGIN]).sendTransactionBinary(Uint8Array.from([1]))).toBe(
      'from-fallback',
    );
  });

  it('does not fail over on a rejection, which another endpoint would repeat', async () => {
    let fallbackHit = false;
    server.use(
      http.post(`${ORIGIN_DOWN}/send-bin`, () =>
        HttpResponse.json({ error: 'unauthorized', message: 'bad key' }, { status: 401 }),
      ),
      http.post(`${ORIGIN}/send-bin`, () => {
        fallbackHit = true;
        return HttpResponse.json({ signature: 'x' });
      }),
    );
    const err = await client(ORIGIN_DOWN, [ORIGIN])
      .sendTransactionBinary(Uint8Array.from([1]))
      .catch((e) => e);
    expect(err.apex.label).toBe('unauthorized');
    expect(fallbackHit).toBe(false);
  });
});

describe('Solana helpers', () => {
  const rpc = () =>
    new RpcClientBuilder()
      .url(SOLANA)
      .retry({ initialDelayMs: 1, maxDelayMs: 5, multiplier: 1, maxAttempts: 1 })
      .build();

  it('lists the tip program vaults with the vault filters', async () => {
    server.use(
      http.post(SOLANA, async ({ request }) => {
        await record(request);
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: 1,
          result: [
            { pubkey: 'APeXn29deoxpsZz6r7n63Ymmv2skBr3WhKYLB1mB2fR7' },
            { pubkey: 'APeX2oLtjYehgTMUCA971L8htM7tGNqsXHDz5NrivhhX' },
          ],
        });
      }),
    );
    expect(await fetchApexVaults(rpc())).toEqual([
      'APeX2oLtjYehgTMUCA971L8htM7tGNqsXHDz5NrivhhX',
      'APeXn29deoxpsZz6r7n63Ymmv2skBr3WhKYLB1mB2fR7',
    ]);
    const [program, config] = last().json.params;
    expect(program).toBe('9ig7pd4gqe2m16ACGPbPo4HfMGD3ba38poDhXEayx7EF');
    expect(config.filters).toEqual([
      { dataSize: 41 },
      { memcmp: { offset: 0, bytes: 'QVBFWFZMVDE=', encoding: 'base64' } },
    ]);
  });

  it('waits for confirmation and reports the slot', async () => {
    let polls = 0;
    server.use(
      http.post(SOLANA, () => {
        polls += 1;
        const status = polls < 3 ? 'processed' : 'confirmed';
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: 1,
          result: { value: [{ slot: 99, err: null, confirmationStatus: status }] },
        });
      }),
    );
    expect(await waitForConfirmation(rpc(), 'sig', { pollMs: 5 })).toBe(99);
    expect(polls).toBe(3);
  });

  it('throws when the transaction failed on chain and returns null on timeout', async () => {
    server.use(
      http.post(SOLANA, async ({ request }) => {
        const body: any = await request.json();
        const sig = body.params[0][0];
        const value =
          sig === 'failed'
            ? [
                {
                  slot: 7,
                  err: { InstructionError: [0, 'Custom'] },
                  confirmationStatus: 'processed',
                },
              ]
            : [null];
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: { value } });
      }),
    );
    await expect(waitForConfirmation(rpc(), 'failed', { pollMs: 5 })).rejects.toThrow(
      /failed on chain/,
    );
    expect(await waitForConfirmation(rpc(), 'never', { timeoutMs: 30, pollMs: 5 })).toBeNull();
  });
});
