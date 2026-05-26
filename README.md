# Frontier Engine

Stateful planned diff engine, adaptive profiles, history planning, and reusable diff caches for Frontier.

This package sits above [`@shapeshift-labs/frontier`](https://www.npmjs.com/package/@shapeshift-labs/frontier), the small JSON diff/apply core package. It uses [`@shapeshift-labs/frontier-codec`](https://www.npmjs.com/package/@shapeshift-labs/frontier-codec) for patch-history byte helpers. Keeping the engine separate keeps core imports small while giving state, history, and CRDT layers a shared planning surface.

- npm: [`@shapeshift-labs/frontier-engine`](https://www.npmjs.com/package/@shapeshift-labs/frontier-engine)
- source: [`siliconjungle/-shapeshift-labs-frontier-engine`](https://github.com/siliconjungle/-shapeshift-labs-frontier-engine)
- license: MIT

## Related Packages

The published Frontier package family is generated from one shared package catalog so READMEs stay in sync across packages:

- [`@shapeshift-labs/frontier`](https://www.npmjs.com/package/@shapeshift-labs/frontier): Core JSON diff/apply, compact patch tuples, JSON Pointer, equality, clone, validation, Unicode helpers.
- [`@shapeshift-labs/frontier-query`](https://www.npmjs.com/package/@shapeshift-labs/frontier-query): Shared query-key, selector path, condition, entity identity, and table-shape primitives.
- [`@shapeshift-labs/frontier-codec`](https://www.npmjs.com/package/@shapeshift-labs/frontier-codec): Patch serialization, binary frames, canonical JSON, and patch-history codecs.
- [`@shapeshift-labs/frontier-state`](https://www.npmjs.com/package/@shapeshift-labs/frontier-state): Patch-routed app-state subscriptions, owned commits, maintained views, and path mapping.
- [`@shapeshift-labs/frontier-state-cache`](https://www.npmjs.com/package/@shapeshift-labs/frontier-state-cache): Normalized query-result cache with entity/query watchers, persistence, change logs, optimistic layers, and mutation bridge.
- [`@shapeshift-labs/frontier-state-cache-idb`](https://www.npmjs.com/package/@shapeshift-labs/frontier-state-cache-idb): IndexedDB persistence adapter for Frontier state-cache snapshots.
- [`@shapeshift-labs/frontier-state-cache-file`](https://www.npmjs.com/package/@shapeshift-labs/frontier-state-cache-file): Structured file persistence adapter for Frontier state-cache snapshots and change logs.
- [`@shapeshift-labs/frontier-state-cache-sql`](https://www.npmjs.com/package/@shapeshift-labs/frontier-state-cache-sql): SQL persistence adapter for Frontier state-cache snapshots and change logs.
- [`@shapeshift-labs/frontier-schema`](https://www.npmjs.com/package/@shapeshift-labs/frontier-schema): JSON Schema validation, Frontier profile generation, CloudEvent envelopes, and query/table schema helpers.
- [`@shapeshift-labs/frontier-event-log`](https://www.npmjs.com/package/@shapeshift-labs/frontier-event-log): Bounded event logs, replay cursors, consumer acknowledgements, keyed compaction, checkpoints, and Frontier patch event records.
- [`@shapeshift-labs/frontier-logging`](https://www.npmjs.com/package/@shapeshift-labs/frontier-logging): Opt-in structured logging, browser telemetry, file sinks, exporters, benchmark traces, and Frontier patch/update summaries.
- [`@shapeshift-labs/frontier-mutation`](https://www.npmjs.com/package/@shapeshift-labs/frontier-mutation): Explicit mutation and selector plans compiled to Frontier patches or CRDT operations.
- [`@shapeshift-labs/frontier-crdt`](https://www.npmjs.com/package/@shapeshift-labs/frontier-crdt): Native CRDT documents, update tooling, awareness, branches, conflict introspection, version frames, and undo.
- [`@shapeshift-labs/frontier-crdt-sync`](https://www.npmjs.com/package/@shapeshift-labs/frontier-crdt-sync): CRDT sync endpoints, repo/storage/provider contracts, document URLs, local networks, model checking, forensics, and text binding contracts.
- [`@shapeshift-labs/frontier-crdt-websocket`](https://www.npmjs.com/package/@shapeshift-labs/frontier-crdt-websocket): WebSocket client/server transports for Frontier CRDT sync providers.
- [`@shapeshift-labs/frontier-react`](https://www.npmjs.com/package/@shapeshift-labs/frontier-react): React external-store hooks and adapters for Frontier state, cache, and CRDT surfaces.
- [`@shapeshift-labs/frontier-richtext`](https://www.npmjs.com/package/@shapeshift-labs/frontier-richtext): Rich text Delta normalization/application, marks, embeds, ranges, and cursor/selection transforms for local editor integrations.

Package source repositories:

- [`siliconjungle/-shapeshift-labs-frontier`](https://github.com/siliconjungle/-shapeshift-labs-frontier)
- [`siliconjungle/-shapeshift-labs-frontier-query`](https://github.com/siliconjungle/-shapeshift-labs-frontier-query)
- [`siliconjungle/-shapeshift-labs-frontier-codec`](https://github.com/siliconjungle/-shapeshift-labs-frontier-codec)
- [`siliconjungle/-shapeshift-labs-frontier-engine`](https://github.com/siliconjungle/-shapeshift-labs-frontier-engine)
- [`siliconjungle/-shapeshift-labs-frontier-state`](https://github.com/siliconjungle/-shapeshift-labs-frontier-state)
- [`siliconjungle/-shapeshift-labs-frontier-state-cache`](https://github.com/siliconjungle/-shapeshift-labs-frontier-state-cache)
- [`siliconjungle/-shapeshift-labs-frontier-state-cache-idb`](https://github.com/siliconjungle/-shapeshift-labs-frontier-state-cache-idb)
- [`siliconjungle/-shapeshift-labs-frontier-state-cache-file`](https://github.com/siliconjungle/-shapeshift-labs-frontier-state-cache-file)
- [`siliconjungle/-shapeshift-labs-frontier-state-cache-sql`](https://github.com/siliconjungle/-shapeshift-labs-frontier-state-cache-sql)
- [`siliconjungle/-shapeshift-labs-frontier-schema`](https://github.com/siliconjungle/-shapeshift-labs-frontier-schema)
- [`siliconjungle/-shapeshift-labs-frontier-event-log`](https://github.com/siliconjungle/-shapeshift-labs-frontier-event-log)
- [`siliconjungle/-shapeshift-labs-frontier-logging`](https://github.com/siliconjungle/-shapeshift-labs-frontier-logging)
- [`siliconjungle/-shapeshift-labs-frontier-mutation`](https://github.com/siliconjungle/-shapeshift-labs-frontier-mutation)
- [`siliconjungle/-shapeshift-labs-frontier-crdt`](https://github.com/siliconjungle/-shapeshift-labs-frontier-crdt)
- [`siliconjungle/-shapeshift-labs-frontier-crdt-sync`](https://github.com/siliconjungle/-shapeshift-labs-frontier-crdt-sync)
- [`siliconjungle/-shapeshift-labs-frontier-crdt-websocket`](https://github.com/siliconjungle/-shapeshift-labs-frontier-crdt-websocket)
- [`siliconjungle/-shapeshift-labs-frontier-react`](https://github.com/siliconjungle/-shapeshift-labs-frontier-react)
- [`siliconjungle/-shapeshift-labs-frontier-richtext`](https://github.com/siliconjungle/-shapeshift-labs-frontier-richtext)

## Planned Realtime and Game Packages

The following repositories are reserved placeholders for future realtime and game-facing Frontier packages. They are not production-ready packages and should not be treated as benchmarked or stable npm surfaces yet.

- [`@shapeshift-labs/frontier-realtime`](https://github.com/siliconjungle/-shapeshift-labs-frontier-realtime): planned realtime command, tick, snapshot, prediction, reconciliation, interpolation, and rollback primitives.
- [`@shapeshift-labs/frontier-realtime-server`](https://github.com/siliconjungle/-shapeshift-labs-frontier-realtime-server): planned authoritative server runtime for rooms, ticks, validation, lag-compensation history, and replication policy.
- [`@shapeshift-labs/frontier-realtime-websocket`](https://github.com/siliconjungle/-shapeshift-labs-frontier-realtime-websocket): planned WebSocket transport for realtime commands and snapshots.
- [`@shapeshift-labs/frontier-game`](https://github.com/siliconjungle/-shapeshift-labs-frontier-game): planned game-facing entity, component, player, room, ownership, and replication vocabulary above realtime.

## Install

```sh
npm install @shapeshift-labs/frontier @shapeshift-labs/frontier-codec @shapeshift-labs/frontier-engine
```

## Usage

```ts
import { applyPatchImmutable } from '@shapeshift-labs/frontier';
import { createDiffEngine } from '@shapeshift-labs/frontier-engine';

const engine = createDiffEngine({
  schema: {
    type: 'array',
    path: ['todos'],
    key: 'id',
    item: {
      type: 'object',
      fields: ['id', 'done', 'title']
    }
  }
});

const before = {
  todos: [{ id: 'a', done: false, title: 'Draft' }]
};
const after = {
  todos: [{ id: 'a', done: true, title: 'Draft' }]
};

const patch = engine.diff(before, after);
const next = applyPatchImmutable(before, patch);
```

## API

```ts
import {
  createDiffEngine,
  cloneProfilePlans,
  createEngineProfilePlansSnapshot,
  mergeProfilePlans,
  readProfilePlans,
  type DiffEngine,
  type DiffProfile,
  type EngineOptions,
  type ProfilePlans
} from '@shapeshift-labs/frontier-engine';
```

### `createDiffEngine(options?)`

Creates a reusable diff engine with optional schema, adaptive learning, history planning, and equality/profile helpers.

```ts
const engine = createDiffEngine({
  adaptive: true,
  adaptiveThreshold: 2,
  arrayKey: 'id'
});

const patch = engine.diff(before, after);
const reusable = [];
engine.diffInto(before, after, reusable);
```

### Schema Plans

Schema plans are trusted shape hints for hot JSON structures. They let the engine skip generic discovery and emit compact patches for common record-array and object shapes.

```ts
const engine = createDiffEngine({
  schema: {
    type: 'array',
    path: ['rows'],
    key: 'id',
    item: {
      type: 'object',
      fields: ['id', 'score', 'active', 'label']
    }
  }
});
```

### Numeric Quantization Profiles

Quantization is opt-in engine/profile behavior for deterministic simulations, replay fixtures, and collaborative apps that want fixed-step numeric drift tolerance. It only runs inside schema/adaptive planned fields; default `diff()` and generic fallback semantics still preserve exact JSON numbers.

```ts
const engine = createDiffEngine({
  schema: {
    type: 'array',
    path: ['bodies'],
    key: 'id',
    item: { type: 'object', fields: ['id', 'x', 'y'] }
  },
  quantization: [
    { path: ['bodies', '*', 'x'], step: 0.001, fixedStep: true },
    { path: ['bodies', '*', 'y'], step: 0.001, fixedStep: true }
  ]
});
```

### Adaptive Profiles

Adaptive engines can learn a profile from representative before/after pairs and replay that profile later.

```ts
const trainer = createDiffEngine({ adaptive: true });
const profile = trainer.train([[before, after]]);

const profiled = createDiffEngine({ profile });
const patch = profiled.diff(before, after);
```

### History Helpers

The engine can plan patch histories, then delegate binary history encoding to `@shapeshift-labs/frontier-codec`.

```ts
const patches = engine.diffHistory(initial, states);
const bytes = engine.encodeHistory(patches);
const final = engine.applyEncodedHistory(initial, bytes);
```

### Profile Plan Helpers

```ts
const plans = createEngineProfilePlansSnapshot(undefined, {
  schemaCount: 1,
  adaptivePlan: false,
  historyStrategy: 'auto'
});

const merged = mergeProfilePlans(plans, { codec: { history: 'binary' } });
```

## Subpath Imports

```ts
import { createDiffEngine } from '@shapeshift-labs/frontier-engine/engine';
import { mergeProfilePlans } from '@shapeshift-labs/frontier-engine/profile';
import type { DiffEngine } from '@shapeshift-labs/frontier-engine/types';
```

## Package Scope

This package owns:

- `createDiffEngine()`.
- Adaptive shape learning.
- Explicit schema/profile diff planning.
- Reusable engine caches.
- Profile plan snapshots shared by state/history/codec/CRDT layers.
- Engine-level history helpers that delegate byte formats to `frontier-codec`.

It does not own:

- Stateless diff/apply primitives. Those stay in `@shapeshift-labs/frontier`.
- Patch wire formats. Those stay in `@shapeshift-labs/frontier-codec`.
- State subscriptions, routers, or maintained views. Those stay in Frontier state packages.
- CRDT actors, updates, heads, branches, sync, awareness, rich text, or providers.

## TypeScript

The package ships ESM JavaScript plus `.d.ts` declarations for the root export and public subpaths. The package-local TypeScript source lives in `src/` and compiles directly to `dist/`; it is not copied from the monorepo root build output.

## Validation

```sh
npm test
npm run fuzz
npm run bench
npm run pack:dry
```

The package test suite covers root and subpath imports, schema diff/apply replay, profile snapshots, optional numeric quantization, history planning, encoded history replay, and the absence of state/CRDT exports. The fuzzer covers schema and adaptive profile round-trips over record-array and object-shaped JSON.

## Benchmarks

Run the package-local benchmark:

```sh
npm run bench
```

Latest local package benchmark on Node v26.1.0, darwin arm64, 15 rounds:

| Fixture | Median | p95 |
| --- | ---: | ---: |
| Core diff, 1k rows with arrayKey | 270.25 us | 279.41 us |
| Engine schema diff, 1k rows | 13.85 us | 14.97 us |
| Engine quantized schema diff, 1k rows | 148.42 us | 152.22 us |
| Engine quantized drift no-op, 1k rows | 145.63 us | 159.05 us |
| Engine apply via core patch | 0.40 us | 0.59 us |
| Engine equality no-op | 9.59 us | 10.42 us |
| Engine history encode/decode/apply | 3.55 us | 4.19 us |

These are Frontier-only package measurements, not competitor comparisons.

## License

MIT. See [LICENSE](./LICENSE).
