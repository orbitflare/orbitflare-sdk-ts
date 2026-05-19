import { describe, expect, it } from 'vitest';

import { OrbitflareError } from '../src/error.js';
import { defaultRetryPolicy, delayForAttempt, hasAttemptsLeft } from '../src/retry.js';

describe('error retryable classification', () => {
  it('classifies retryable errors', () => {
    const retryable = [
      OrbitflareError.transport(new Error('reset')),
      OrbitflareError.timeout(),
      OrbitflareError.rateLimited(5000),
      OrbitflareError.rateLimited(),
      OrbitflareError.stream('closed'),
      OrbitflareError.rpc(-32005, 'x'),
      OrbitflareError.rpc(-32007, 'x'),
      OrbitflareError.rpc(-32014, 'x'),
      OrbitflareError.rpc(-32015, 'x'),
      OrbitflareError.rpc(-32016, 'x'),
    ];
    for (const e of retryable) expect(e.isRetryable(), e.message).toBe(true);
  });

  it('classifies non-retryable errors', () => {
    const notRetryable = [
      OrbitflareError.auth('bad'),
      OrbitflareError.config('bad'),
      OrbitflareError.serialization('bad'),
      OrbitflareError.rpc(-32600, 'x'),
      OrbitflareError.rpc(-32602, 'x'),
      OrbitflareError.rpc(0, 'x'),
      OrbitflareError.grpc(16, 'x'),
    ];
    for (const e of notRetryable) expect(e.isRetryable(), e.message).toBe(false);
  });
});

describe('retryAfter', () => {
  it('only set on rate-limited errors', () => {
    expect(OrbitflareError.rateLimited(30_000).retryAfter()).toBe(30_000);
    expect(OrbitflareError.rateLimited().retryAfter()).toBeUndefined();
    expect(OrbitflareError.timeout().retryAfter()).toBeUndefined();
    expect(OrbitflareError.rpc(-32005, 'x').retryAfter()).toBeUndefined();
  });
});

describe('withEndpoint', () => {
  it('prepends host on wrapping variants', () => {
    const cases = [
      OrbitflareError.rpc(-32404, 'rejected'),
      OrbitflareError.grpc(16, 'rejected'),
      OrbitflareError.transport(new Error('rejected')),
    ];
    for (const e of cases) {
      const wrapped = e.withEndpoint('http://fra.rpc.orbitflare.com');
      expect(wrapped.message).toContain('[http://fra.rpc.orbitflare.com]');
      expect(wrapped.message).toContain('rejected');
    }
  });

  it('passes through rate-limited unchanged', () => {
    const e = OrbitflareError.rateLimited(10_000);
    const wrapped = e.withEndpoint('http://fra.rpc.orbitflare.com');
    expect(wrapped.kind).toBe('rateLimited');
    expect(wrapped.retryAfter()).toBe(10_000);
  });

  it('strips api_key from host in messages', () => {
    const e = OrbitflareError.rpc(0, 'fail');
    const wrapped = e.withEndpoint('http://fra.rpc.orbitflare.com?api_key=ORBIT-SECRET-123');
    expect(wrapped.message).not.toContain('ORBIT-SECRET-123');
    expect(wrapped.message).toContain('fra.rpc.orbitflare.com');
  });
});

describe('retry policy', () => {
  it('has expected defaults', () => {
    const p = defaultRetryPolicy();
    expect(p.initialDelayMs).toBe(100);
    expect(p.maxDelayMs).toBe(30_000);
    expect(p.multiplier).toBe(2);
    expect(p.maxAttempts).toBe(0);
  });

  it('respects max attempts', () => {
    const finite = { ...defaultRetryPolicy(), maxAttempts: 3 };
    expect(hasAttemptsLeft(finite, 1)).toBe(true);
    expect(hasAttemptsLeft(finite, 2)).toBe(true);
    expect(hasAttemptsLeft(finite, 3)).toBe(false);

    const infinite = { ...defaultRetryPolicy(), maxAttempts: 0 };
    expect(hasAttemptsLeft(infinite, 999)).toBe(true);
  });

  it('grows and caps the delay', () => {
    const p = {
      initialDelayMs: 100,
      maxDelayMs: 500,
      multiplier: 2,
      maxAttempts: 0,
    };
    const d1 = delayForAttempt(p, 1);
    const d2 = delayForAttempt(p, 2);
    const d3 = delayForAttempt(p, 3);
    expect(d2).toBeGreaterThanOrEqual(d1);
    expect(d3).toBeGreaterThanOrEqual(d2);
    const dn = delayForAttempt(p, 20);
    expect(dn).toBeLessThanOrEqual(625);
  });
});
