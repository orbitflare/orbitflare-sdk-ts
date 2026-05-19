<p align="center">
  <img src="https://raw.githubusercontent.com/orbitflare/orbitflare-sdk-ts/main/assets/banner.png" alt="@orbitflare/sdk" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@orbitflare/sdk"><img src="https://img.shields.io/npm/v/@orbitflare/sdk.svg?style=flat-square&color=3CAB9C&labelColor=041815" alt="npm"></a>
  <a href="https://docs.orbitflare.com/sdk/overview"><img src="https://img.shields.io/badge/docs-orbitflare.com-3CAB9C?style=flat-square&labelColor=041815" alt="Documentation"></a>
</p>

# @orbitflare/sdk

TypeScript SDK for [OrbitFlare](https://orbitflare.com) - RPC, gRPC (Yellowstone Geyser), JetStream, and WebSocket clients for Solana.

## Install

```bash
npm install @orbitflare/sdk
```

The RPC client works out of the box. Add only the peer dependencies for the transports you actually use:

```bash
npm install ws            # WebSocket subscriptions
npm install @grpc/grpc-js # gRPC streaming (Yellowstone, JetStream)
npm install yaml          # YAML stream config files
```

## RPC

```ts
import { RpcClientBuilder } from '@orbitflare/sdk';

const client = new RpcClientBuilder()
  .url('http://ny.rpc.orbitflare.com')
  .commitment('confirmed')
  .build();

const slot = await client.getSlot();
const balance = await client.getBalance('CKs1E69a2e9TmH4mKKLrXFF8kD3ZnwKjoEuXa6sz9WqX');
const { blockhash, lastValidBlockHeight } = await client.getLatestBlockhash();

const inflation = await client.request('getInflationRate', []);

const raw = await client.requestRaw(
  '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}',
);
```

### Typed helpers

| Method | Returns |
|---|---|
| `getSlot()` | Current slot (`number`) |
| `getBalance(address)` | Lamports (`number`) |
| `getAccountInfo(address)` | Account data or `null` |
| `getMultipleAccounts(addresses)` | Array of accounts (auto-chunks to 100) |
| `getLatestBlockhash()` | `{ blockhash, lastValidBlockHeight }` |
| `getTransaction(signature)` | Full transaction with metadata |
| `getSignaturesForAddress(address, limit)` | Recent signatures |
| `getProgramAccounts(programId)` | All accounts owned by a program |
| `getRecentPrioritizationFees(addresses)` | Recent priority fees |
| `sendTransaction(txBase64)` | Signature string |
| `simulateTransaction(txBase64)` | Simulation result |
| `getTokenAccountsByOwner(owner, mint?, programId?)` | Token accounts |
| `getTransactionsForAddress(address, options)` | Full transaction history with filters and pagination (OrbitFlare-specific) |
| `request(method, params)` | Any RPC method by name |
| `requestRaw(body)` | Raw JSON-RPC body string |

## gRPC (Yellowstone Geyser)

Subscribe using a YAML config file:

```yaml
# grpc.yml
transactions:
  pumpfun:
    vote: false
    failed: false
    account_include:
      - "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"

commitment: confirmed
```

```ts
import { GeyserClientBuilder } from '@orbitflare/sdk';

const client = new GeyserClientBuilder()
  .url('http://ny.rpc.orbitflare.com:10000')
  .build();

const stream = client.subscribeYaml('grpc.yml');

for await (const update of stream) {
  if (update.transaction) {
    console.log(`slot=${update.transaction.slot}`);
  }
}
```

The YAML format supports `${ENV_VAR}` expansion. You can also call `client.subscribe(request)` with a programmatically constructed `SubscribeRequest`.

## JetStream

```yaml
# jetstream.yml
transactions:
  raydium:
    account_include:
      - "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
```

```ts
import { JetstreamClientBuilder } from '@orbitflare/sdk';

const client = new JetstreamClientBuilder()
  .url('http://ny.jetstream.orbitflare.com')
  .build();

const stream = client.subscribeYaml('jetstream.yml');

for await (const update of stream) {
  if (update.transaction) {
    console.log(`slot=${update.transaction.slot}`);
  }
}
```

## WebSocket

```ts
import { WsClientBuilder } from '@orbitflare/sdk';

const client = await new WsClientBuilder()
  .url('ws://ny.rpc.orbitflare.com')
  .build();

const sub = await client.slotSubscribe();

while (true) {
  const slot = await sub.next();
  if (slot === undefined) break;
  console.log(slot);
}
```

Subscription types: `accountSubscribe`, `logsSubscribe`, `slotSubscribe`, `signatureSubscribe`. All auto-resubscribe on reconnect.

## Endpoint failover

All clients support multiple endpoints with automatic failover and health tracking.

```ts
const client = new RpcClientBuilder()
  .urls([
    'http://ny.rpc.orbitflare.com',
    'http://fra.rpc.orbitflare.com',
    'http://ams.rpc.orbitflare.com',
  ])
  .build();
```

Failing endpoints are quarantined with exponential cooldown (10s, 20s, 40s, max 60s) and automatically retried once the cooldown expires. Healthy endpoints are always preferred.

## Retry

RPC calls retry on transient errors (5xx, 429, connection resets, Solana error codes -32005, -32007, -32014, -32015, -32016) with exponential backoff before failing over to the next endpoint. 429 responses with a `Retry-After` header are respected.

gRPC, JetStream, and WebSocket connections use active ping/pong to detect dead connections. Configurable via the builder:

```ts
const client = new GeyserClientBuilder()
  .url('http://ny.rpc.orbitflare.com:10000')
  .pingIntervalSecs(15)   // send a ping every 15s (default: 10)
  .maxMissedPongs(5)      // kill connection after 5 missed pongs (default: 3)
  .build();
```

All three streaming clients reconnect automatically on disconnection. WebSocket also re-subscribes all active subscriptions after reconnecting.

Configure retry behavior:

```ts
import { RpcClientBuilder } from '@orbitflare/sdk';

const client = new RpcClientBuilder()
  .url('http://ny.rpc.orbitflare.com')
  .retry({
    initialDelayMs: 200,
    maxDelayMs: 15_000,
    multiplier: 2.0,
    maxAttempts: 5,
  })
  .build();
```

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `ORBITFLARE_LICENSE_KEY` | RPC, WebSocket | API key appended to endpoint URLs |
| `ORBITFLARE_RPC_URL` | RPC | Default endpoint if `.url()` is not called |
| `ORBITFLARE_WS_URL` | WebSocket | Default endpoint if `.url()` is not called |
| `ORBITFLARE_GRPC_URL` | gRPC | Default endpoint if `.url()` is not called |
| `ORBITFLARE_JETSTREAM_URL` | JetStream | Default endpoint if `.url()` is not called |

## Examples

Eight runnable examples live in [`examples/`](./examples), covering every transport in basic and full variants.

```bash
git clone https://github.com/orbitflare/orbitflare-sdk-ts.git
cd orbitflare-sdk-ts
npm install
npm run proto
npm run build

export ORBITFLARE_LICENSE_KEY=ORBIT-...

npm run example:rpc-basic
npm run example:rpc-full
npm run example:ws-basic
npm run example:ws-full
npm run example:grpc-basic
npm run example:grpc-full
npm run example:jetstream-basic
npm run example:jetstream-full
```
