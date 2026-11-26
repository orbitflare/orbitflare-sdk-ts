import { sanitizeUrl } from './error.js';

const CAPACITY = 256;

export type ConnectionEvent =
  | { type: 'connecting'; endpoint: string; attempt: number }
  | { type: 'connected'; endpoint: string }
  | { type: 'disconnected'; endpoint: string; error: string; retryInMs?: number }
  | { type: 'replayClamped'; requested: bigint; available: bigint }
  | { type: 'replayUnavailable'; requested: bigint }
  | { type: 'lagged'; missed: number };

export class ConnectionEvents {
  private queue: ConnectionEvent[] = [];
  private missed = 0;
  private waiting: ((v: ConnectionEvent | undefined) => void)[] = [];
  private ended = false;

  async recv(): Promise<ConnectionEvent | undefined> {
    const ready = this.tryRecv();
    if (ready !== undefined || this.ended) return ready;
    return new Promise<ConnectionEvent | undefined>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  tryRecv(): ConnectionEvent | undefined {
    if (this.missed > 0) {
      const missed = this.missed;
      this.missed = 0;
      return { type: 'lagged', missed };
    }
    return this.queue.shift();
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<ConnectionEvent> {
    while (true) {
      const event = await this.recv();
      if (event === undefined) return;
      yield event;
    }
  }

  _push(event: ConnectionEvent): void {
    if (this.ended) return;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    if (this.queue.length >= CAPACITY) {
      this.queue.shift();
      this.missed += 1;
    }
    this.queue.push(event);
  }

  _end(): void {
    this.ended = true;
    while (this.waiting.length > 0) this.waiting.shift()!(undefined);
  }
}

export class EventHub {
  private readers: ConnectionEvents[] = [];
  private first: ConnectionEvents | undefined;
  private ended = false;

  constructor() {
    this.first = new ConnectionEvents();
    this.readers.push(this.first);
  }

  subscribe(): ConnectionEvents {
    const first = this.first;
    this.first = undefined;
    if (first) return first;
    const reader = new ConnectionEvents();
    if (this.ended) reader._end();
    else this.readers.push(reader);
    return reader;
  }

  emit(event: ConnectionEvent): void {
    for (const reader of this.readers) reader._push(event);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const reader of this.readers) reader._end();
  }
}

export function endpointLabel(url: string): string {
  const clean = sanitizeUrl(url);
  const sep = clean.indexOf('://');
  if (sep === -1) return clean;
  const scheme = clean.slice(0, sep);
  const rest = clean.slice(sep + 3);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  const at = authority.lastIndexOf('@');
  const host = at === -1 ? authority : authority.slice(at + 1);
  return `${scheme}://${host}${path}`;
}
