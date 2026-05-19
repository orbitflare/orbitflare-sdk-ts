import { ChannelCredentials } from '@grpc/grpc-js';

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
