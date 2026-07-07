export type MemcmpData = { bytes: Uint8Array } | { base58: string } | { base64: string };

export class Memcmp {
  constructor(
    readonly offset: number,
    readonly data: MemcmpData,
  ) {}

  static bytes(offset: number, bytes: Uint8Array): Memcmp {
    return new Memcmp(offset, { bytes });
  }

  static base58(offset: number, data: string): Memcmp {
    return new Memcmp(offset, { base58: data });
  }

  static base64(offset: number, data: string): Memcmp {
    return new Memcmp(offset, { base64: data });
  }
}

export type LamportsCmp = { eq: number } | { ne: number } | { lt: number } | { gt: number };

export class Lamports {
  constructor(readonly cmp: LamportsCmp) {}

  static eq(value: number): Lamports {
    return new Lamports({ eq: value });
  }

  static ne(value: number): Lamports {
    return new Lamports({ ne: value });
  }

  static lt(value: number): Lamports {
    return new Lamports({ lt: value });
  }

  static gt(value: number): Lamports {
    return new Lamports({ gt: value });
  }
}

export enum Commitment {
  Processed = 0,
  Confirmed = 1,
  Finalized = 2,
}
