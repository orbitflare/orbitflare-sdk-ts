import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse, delay } from 'msw';

import { OrbitflareError } from '../src/error.js';
import { RpcClientBuilder, type GetTransactionsOptions } from '../src/rpc.js';

const ORIGIN = 'http://orbitflare.test';
const ORIGIN_BAD = 'http://orbitflare.bad';
const ORIGIN_GOOD = 'http://orbitflare.good';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const okJson = (result: unknown) => HttpResponse.json({ jsonrpc: '2.0', id: 1, result });

const buildClient = (
  url: string = ORIGIN,
  overrides: Partial<{
    fallbacks: string[];
    apiKey: string;
    maxAttempts: number;
    timeoutMs: number;
  }> = {},
) => {
  let b = new RpcClientBuilder().url(url);
  if (overrides.fallbacks) b = b.fallbackUrls(overrides.fallbacks);
  if (overrides.apiKey) b = b.apiKey(overrides.apiKey);
  b = b.retry({
    initialDelayMs: 5,
    maxDelayMs: 50,
    multiplier: 1.5,
    maxAttempts: overrides.maxAttempts ?? 1,
  });
  if (overrides.timeoutMs) b = b.timeoutMs(overrides.timeoutMs);
  return b.build();
};

describe('typed helpers', () => {
  it('getSlot returns u64', async () => {
    server.use(http.post(ORIGIN, () => okJson(12345)));
    const c = buildClient();
    expect(await c.getSlot()).toBe(12345);
  });

  it('getBalance returns lamports', async () => {
    server.use(http.post(ORIGIN, () => okJson({ value: 999_000_000 })));
    const c = buildClient();
    expect(await c.getBalance('addr')).toBe(999_000_000);
  });

  it('getLatestBlockhash returns hash and height', async () => {
    server.use(
      http.post(ORIGIN, () =>
        okJson({ value: { blockhash: 'abc123', lastValidBlockHeight: 500 } }),
      ),
    );
    const c = buildClient();
    const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash();
    expect(blockhash).toBe('abc123');
    expect(lastValidBlockHeight).toBe(500);
  });

  it('getAccountInfo returns null for missing', async () => {
    server.use(http.post(ORIGIN, () => okJson({ value: null })));
    const c = buildClient();
    expect(await c.getAccountInfo('missing')).toBeNull();
  });

  it('getAccountInfo returns the account when present', async () => {
    server.use(
      http.post(ORIGIN, () =>
        okJson({
          value: {
            lamports: 100,
            owner: '11111',
            data: ['', 'base64'],
            executable: false,
          },
        }),
      ),
    );
    const c = buildClient();
    const acct = await c.getAccountInfo('addr');
    expect(acct).not.toBeNull();
    expect(acct.lamports).toBe(100);
  });

  it('getMultipleAccounts maps null entries', async () => {
    server.use(
      http.post(ORIGIN, () => okJson({ value: [{ lamports: 10 }, null, { lamports: 30 }] })),
    );
    const c = buildClient();
    const accounts = await c.getMultipleAccounts(['a', 'b', 'c']);
    expect(accounts).toHaveLength(3);
    expect(accounts[0]).not.toBeNull();
    expect(accounts[1]).toBeNull();
    expect(accounts[2]).not.toBeNull();
  });

  it('getTransaction returns the result', async () => {
    server.use(
      http.post(ORIGIN, () => okJson({ slot: 100, meta: { fee: 5000 }, transaction: {} })),
    );
    const c = buildClient();
    const tx = await c.getTransaction('sig');
    expect(tx.slot).toBe(100);
    expect(tx.meta.fee).toBe(5000);
  });

  it('getSignaturesForAddress returns array', async () => {
    server.use(
      http.post(ORIGIN, () =>
        okJson([
          { signature: 'aaa', slot: 1 },
          { signature: 'bbb', slot: 2 },
        ]),
      ),
    );
    const c = buildClient();
    const sigs = await c.getSignaturesForAddress('addr', 2);
    expect(sigs).toHaveLength(2);
  });

  it('simulateTransaction returns the result', async () => {
    server.use(
      http.post(ORIGIN, () =>
        okJson({ value: { err: null, logs: ['log1'], unitsConsumed: 5000 } }),
      ),
    );
    const c = buildClient();
    const r = await c.simulateTransaction('base64tx');
    expect(r.value.err).toBeNull();
  });

  it('sendTransaction returns signature string', async () => {
    server.use(http.post(ORIGIN, () => okJson('5K8F2jABCDEFsig')));
    const c = buildClient();
    expect(await c.sendTransaction('base64tx')).toBe('5K8F2jABCDEFsig');
  });

  it('commitment defaults to confirmed and is overridable', async () => {
    expect(buildClient().commitment()).toBe('confirmed');
    const finalized = new RpcClientBuilder().url(ORIGIN).commitment('finalized').build();
    expect(finalized.commitment()).toBe('finalized');
  });
});

describe('getTransactionsForAddress', () => {
  it('returns data and pagination token', async () => {
    server.use(
      http.post(ORIGIN, () => okJson({ data: [{ signature: 'aaa' }], paginationToken: '387:541' })),
    );
    const c = buildClient();
    const r = await c.getTransactionsForAddress('addr', { limit: 1 });
    expect(r.data).toHaveLength(1);
    expect(r.paginationToken).toBe('387:541');
  });

  it('sends all options through with camelCase', async () => {
    let captured: any;
    server.use(
      http.post(ORIGIN, async ({ request }) => {
        captured = await request.json();
        return okJson({ data: [] });
      }),
    );
    const c = buildClient();
    const options: GetTransactionsOptions = {
      transactionDetails: 'full',
      limit: 50,
      sortOrder: 'asc',
      paginationToken: '100:5',
      commitment: 'finalized',
      filters: {
        tokenAccounts: 'all',
        status: 'succeeded',
        blockTime: { gte: 1704067200, lte: 1706745600 },
      },
    };
    await c.getTransactionsForAddress('addr', options);
    const params = captured.params[1];
    expect(params.transactionDetails).toBe('full');
    expect(params.limit).toBe(50);
    expect(params.sortOrder).toBe('asc');
    expect(params.commitment).toBe('finalized');
    expect(params.filters.tokenAccounts).toBe('all');
    expect(params.filters.blockTime.gte).toBe(1704067200);
  });

  it('omits unset fields from filters', async () => {
    let captured: any;
    server.use(
      http.post(ORIGIN, async ({ request }) => {
        captured = await request.json();
        return okJson({ data: [] });
      }),
    );
    const c = buildClient();
    await c.getTransactionsForAddress('addr', {
      filters: { slot: { gt: 300_000_000, lt: 400_000_000 } },
    });
    const slot = captured.params[1].filters.slot;
    expect(slot.gt).toBe(300_000_000);
    expect(slot.lt).toBe(400_000_000);
    expect(slot.gte).toBeUndefined();
  });
});

describe('error handling', () => {
  it('extracts rpc error from a 200 response', async () => {
    server.use(
      http.post(ORIGIN, () =>
        HttpResponse.json({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32600, message: 'invalid request' },
        }),
      ),
    );
    const c = buildClient();
    await expect(c.getSlot()).rejects.toMatchObject({
      kind: 'rpc',
      rpc: { code: -32600 },
    });
  });

  it('extracts rpc error from non-200 response', async () => {
    server.use(
      http.post(ORIGIN, () =>
        HttpResponse.json(
          {
            jsonrpc: '2.0',
            error: { code: -32404, message: 'IP not whitelisted' },
          },
          { status: 403 },
        ),
      ),
    );
    const c = buildClient();
    await expect(c.getSlot()).rejects.toMatchObject({
      kind: 'rpc',
      rpc: { code: -32404 },
    });
  });

  it('treats 5xx as retryable transport error', async () => {
    server.use(http.post(ORIGIN, () => new HttpResponse('internal error', { status: 500 })));
    const c = buildClient();
    const err = (await c.getSlot().catch((e) => e)) as OrbitflareError;
    expect(err).toBeInstanceOf(OrbitflareError);
    expect(err.kind).toBe('transport');
  });

  it('honors 429 with Retry-After', async () => {
    server.use(
      http.post(
        ORIGIN,
        () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '10' } }),
      ),
    );
    const c = buildClient(ORIGIN, { timeoutMs: 2000 });
    await expect(c.getSlot()).rejects.toMatchObject({
      kind: 'rateLimited',
      retryAfterMs: 10_000,
    });
  });

  it('times out when the server stalls', async () => {
    server.use(
      http.post(ORIGIN, async () => {
        await delay(1500);
        return okJson(1);
      }),
    );
    const c = buildClient(ORIGIN, { timeoutMs: 100 });
    const err = (await c.getSlot().catch((e) => e)) as OrbitflareError;
    expect(err).toBeInstanceOf(OrbitflareError);
    expect(err.isRetryable()).toBe(true);
  });
});

describe('failover and api key', () => {
  it('fails over to a healthy endpoint', async () => {
    server.use(
      http.post(ORIGIN_BAD, () => new HttpResponse('down', { status: 500 })),
      http.post(ORIGIN_GOOD, () => okJson(42)),
    );
    const c = new RpcClientBuilder()
      .urls([ORIGIN_BAD, ORIGIN_GOOD])
      .retry({ initialDelayMs: 5, maxDelayMs: 20, multiplier: 1.5, maxAttempts: 1 })
      .build();
    expect(await c.getSlot()).toBe(42);
  });

  it('fails over on a non-retryable error', async () => {
    server.use(
      http.post(ORIGIN_BAD, () =>
        HttpResponse.json(
          { jsonrpc: '2.0', error: { code: -32404, message: 'IP not whitelisted' } },
          { status: 403 },
        ),
      ),
      http.post(ORIGIN_GOOD, () => okJson(99)),
    );
    const c = new RpcClientBuilder()
      .urls([ORIGIN_BAD, ORIGIN_GOOD])
      .retry({ initialDelayMs: 5, maxDelayMs: 20, multiplier: 1.5, maxAttempts: 1 })
      .build();
    expect(await c.getSlot()).toBe(99);
  });

  it('injects api_key into the URL', async () => {
    let captured: URL | undefined;
    server.use(
      http.post(ORIGIN, ({ request }) => {
        captured = new URL(request.url);
        return okJson(1);
      }),
    );
    const c = new RpcClientBuilder().url(ORIGIN).apiKey('ORBIT-TEST-KEY').build();
    await c.getSlot();
    expect(captured?.searchParams.get('api_key')).toBe('ORBIT-TEST-KEY');
  });

  it('error message includes endpoint context', async () => {
    server.use(http.post(ORIGIN, () => new HttpResponse('boom', { status: 500 })));
    const c = buildClient();
    const err = (await c.getSlot().catch((e) => e)) as OrbitflareError;
    expect(err.message).toContain('orbitflare.test');
  });
});
