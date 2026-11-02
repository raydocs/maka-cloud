# P5 — hi device worker (interface only)

Out of this repository. Default off. No remote unlock. Cloud-originated
payment stays `approval_unavailable`.

A later out-of-repo worker may satisfy `HiDevicePort` in
`@maka-cloud/superagent`. This repo ships `OffHiDevice` so callers can
depend on the type without enabling anything.

```ts
type HiDeviceRefusal = 'disabled' | 'approval_unavailable';

type HiDeviceResult =
  | { ok: true; text: string }
  | { ok: false; reason: HiDeviceRefusal };

interface HiDeviceRequest {
  tenantId: string;
  workerId: string;
  prompt: string;
}

interface HiDevicePort {
  readonly enabled: boolean;
  evaluate(request: HiDeviceRequest): Promise<HiDeviceResult>;
  requestPayment(request: HiDeviceRequest): Promise<HiDeviceResult>;
}
```

Invariants:

- `enabled` is false unless the owner later wires a real device outside this repo.
- `requestPayment` from the cloud must not open a pay path. `OffHiDevice`
  returns `{ ok: false, reason: 'approval_unavailable' }`.
- Android / hi LayerFS: never. Isolation model still applies.
- Super-agent does not call this port in P0–P4. There is no host flag to turn it on.
