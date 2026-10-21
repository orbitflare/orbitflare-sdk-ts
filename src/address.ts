import { ChannelCredentials, InterceptingCall, type Interceptor } from '@grpc/grpc-js';

export interface ParsedAddress {
  target: string;
  credentials: ChannelCredentials;
}

export function parseAddress(url: string): ParsedAddress {
  const u = new URL(url);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const credentials =
    u.protocol === 'https:' ? ChannelCredentials.createSsl() : ChannelCredentials.createInsecure();
  return { target: `${u.hostname}:${port}`, credentials };
}

export function apiKeyInterceptors(apiKey: string | undefined): Interceptor[] {
  if (!apiKey) return [];
  return [
    (options, nextCall) =>
      new InterceptingCall(nextCall(options), {
        start(metadata, listener, next) {
          metadata.set('x-token', apiKey);
          next(metadata, listener);
        },
      }),
  ];
}
