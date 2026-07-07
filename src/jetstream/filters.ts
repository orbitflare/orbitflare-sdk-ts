import type { SubscribeRequest, SubscribeRequestFilterTransactions } from '../proto/jetstream.js';

export class TransactionFilter {
  private _accountInclude: string[] = [];
  private _accountExclude: string[] = [];
  private _accountRequired: string[] = [];

  accountInclude(accounts: string[]): this {
    this._accountInclude.push(...accounts);
    return this;
  }

  accountExclude(accounts: string[]): this {
    this._accountExclude.push(...accounts);
    return this;
  }

  accountRequired(accounts: string[]): this {
    this._accountRequired.push(...accounts);
    return this;
  }

  toProto(): SubscribeRequestFilterTransactions {
    return {
      accountInclude: this._accountInclude,
      accountExclude: this._accountExclude,
      accountRequired: this._accountRequired,
    };
  }
}

export class SubscribeRequestBuilder {
  private _transactions: Record<string, TransactionFilter> = {};

  transactions(name: string, filter: TransactionFilter): this {
    this._transactions[name] = filter;
    return this;
  }

  build(): SubscribeRequest {
    const transactions: Record<string, SubscribeRequestFilterTransactions> = {};
    for (const [k, v] of Object.entries(this._transactions)) transactions[k] = v.toProto();
    return {
      transactions,
      accounts: {},
      ping: { id: 1 },
    };
  }
}
