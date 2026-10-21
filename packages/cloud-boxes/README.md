# @maka-cloud/boxes

A pool of labelled instabox boxes per invite, one task per box. `BoxPool` implements the
`SandboxProvider` of `@maka-cloud/runners`. Design: `docs/fork/design/boxes.md`.

```ts
const pool = new BoxPool({
  api: new InstaboxClient({ apiKey }),
  source: () => ({ templateId }),
  isTaskLive: (taskId) => taskIsRunning(taskId), // the orchestrator's view
  beforeUse: (machineId) => applyEgressGuard(client, machineId),
});
```

Tests run against an in-memory fake of the instabox account (`src/__tests__/fake-fleet.ts`); no
test calls the real API. `npm run test:dist -w @maka-cloud/boxes`.
