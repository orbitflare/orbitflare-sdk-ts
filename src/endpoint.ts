interface Endpoint {
  url: string;
  consecutiveFailures: number;
  availableAfter: number;
}

export class EndpointSet {
  private endpoints: Endpoint[];

  constructor(primary: string, fallbacks: string[] = []) {
    const now = Date.now();
    this.endpoints = [primary, ...fallbacks].map((url) => ({
      url,
      consecutiveFailures: 0,
      availableAfter: now,
    }));
  }

  get length(): number {
    return this.endpoints.length;
  }

  get(idx: number): string {
    const ep = this.endpoints[idx];
    if (!ep) throw new RangeError(`endpoint index ${idx} out of bounds`);
    return ep.url;
  }

  pick(): number {
    const now = Date.now();
    for (let i = 0; i < this.endpoints.length; i++) {
      if (now >= this.endpoints[i]!.availableAfter) return i;
    }
    let bestIdx = 0;
    let best = this.endpoints[0]!.availableAfter;
    for (let i = 1; i < this.endpoints.length; i++) {
      if (this.endpoints[i]!.availableAfter < best) {
        best = this.endpoints[i]!.availableAfter;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  markSuccess(idx: number): void {
    const ep = this.endpoints[idx];
    if (!ep) return;
    ep.consecutiveFailures = 0;
    ep.availableAfter = Date.now();
  }

  markFailure(idx: number): void {
    const ep = this.endpoints[idx];
    if (!ep) return;
    ep.consecutiveFailures += 1;
    const shift = Math.min(ep.consecutiveFailures, 4);
    const secs = Math.min(5 << shift, 60);
    ep.availableAfter = Date.now() + secs * 1000;
  }
}
