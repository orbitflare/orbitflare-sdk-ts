export type ErrorKind =
  | 'transport'
  | 'rpc'
  | 'grpc'
  | 'rateLimited'
  | 'auth'
  | 'timeout'
  | 'stream'
  | 'config'
  | 'serialization';

export interface RpcErrorPayload {
  code: number;
  message: string;
}

export interface GrpcErrorPayload {
  code: number;
  message: string;
}

export class OrbitflareError extends Error {
  readonly kind: ErrorKind;
  readonly rpc?: RpcErrorPayload;
  readonly grpc?: GrpcErrorPayload;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;

  constructor(
    kind: ErrorKind,
    message: string,
    extra: {
      rpc?: RpcErrorPayload;
      grpc?: GrpcErrorPayload;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'OrbitflareError';
    this.kind = kind;
    if (extra.rpc) this.rpc = extra.rpc;
    if (extra.grpc) this.grpc = extra.grpc;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }

  static transport(cause: unknown, message?: string): OrbitflareError {
    const msg = message ?? (cause instanceof Error ? cause.message : String(cause));
    return new OrbitflareError('transport', msg, { cause });
  }

  static rpc(code: number, message: string): OrbitflareError {
    return new OrbitflareError('rpc', `rpc error ${code}: ${message}`, {
      rpc: { code, message },
    });
  }

  static grpc(code: number, message: string): OrbitflareError {
    return new OrbitflareError('grpc', `grpc error (${code}): ${message}`, {
      grpc: { code, message },
    });
  }

  static rateLimited(retryAfterMs?: number): OrbitflareError {
    const suffix =
      retryAfterMs !== undefined ? ` (retry after ${Math.round(retryAfterMs / 1000)}s)` : '';
    return new OrbitflareError('rateLimited', `rate limited${suffix}`, { retryAfterMs });
  }

  static auth(message: string): OrbitflareError {
    return new OrbitflareError('auth', `auth: ${message}`);
  }

  static timeout(): OrbitflareError {
    return new OrbitflareError('timeout', 'request timed out');
  }

  static stream(message: string): OrbitflareError {
    return new OrbitflareError('stream', `stream closed: ${message}`);
  }

  static config(message: string): OrbitflareError {
    return new OrbitflareError('config', message);
  }

  static serialization(message: string): OrbitflareError {
    return new OrbitflareError('serialization', message);
  }

  isRetryable(): boolean {
    switch (this.kind) {
      case 'transport':
      case 'timeout':
      case 'rateLimited':
      case 'stream':
        return true;
      case 'rpc':
        if (!this.rpc) return false;
        return [-32005, -32007, -32014, -32015, -32016].includes(this.rpc.code);
      default:
        return false;
    }
  }

  retryAfter(): number | undefined {
    return this.kind === 'rateLimited' ? this.retryAfterMs : undefined;
  }

  withEndpoint(endpoint: string): OrbitflareError {
    const sanitized = sanitizeUrl(endpoint);
    switch (this.kind) {
      case 'transport':
        return new OrbitflareError('transport', `[${sanitized}] ${this.message}`, {
          cause: this.cause,
        });
      case 'rpc':
        if (!this.rpc) return this;
        return new OrbitflareError(
          'rpc',
          `rpc error ${this.rpc.code}: [${sanitized}] ${this.rpc.message}`,
          {
            rpc: { code: this.rpc.code, message: `[${sanitized}] ${this.rpc.message}` },
          },
        );
      case 'grpc':
        if (!this.grpc) return this;
        return new OrbitflareError(
          'grpc',
          `grpc error (${this.grpc.code}): [${sanitized}] ${this.grpc.message}`,
          {
            grpc: { code: this.grpc.code, message: `[${sanitized}] ${this.grpc.message}` },
          },
        );
      default:
        return this;
    }
  }
}

export function sanitizeUrl(url: string): string {
  let result = url;
  for (const needle of ['?api_key=', '&api_key=']) {
    let start = result.indexOf(needle);
    while (start !== -1) {
      const valueStart = start + needle.length;
      let end = result.length;
      for (let i = valueStart; i < result.length; i++) {
        const c = result[i]!;
        if (c === '&' || c === ')' || /\s/.test(c)) {
          end = i;
          break;
        }
      }
      result = result.slice(0, start) + result.slice(end);
      start = result.indexOf(needle);
    }
  }
  return result;
}
