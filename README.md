# Frontier Engine

Stateful planned diff engine, adaptive profiles, history planning, and reusable diff caches for Frontier.

This package sits above [`@shapeshift-labs/frontier`](https://www.npmjs.com/package/@shapeshift-labs/frontier), the small JSON diff/apply core package. It uses [`@shapeshift-labs/frontier-codec`](https://www.npmjs.com/package/@shapeshift-labs/frontier-codec) for patch-history byte helpers. Keeping the engine separate keeps core imports small while giving state, history, and CRDT layers a shared planning surface.

- npm: [`@shapeshift-labs/frontier-engine`](https://www.npmjs.com/package/@shapeshift-labs/frontier-engine)
- source: [`siliconjungle/-shapeshift-labs-frontier-engine`](https://github.com/siliconjungle/-shapeshift-labs-frontier-engine)
- license: MIT

## Related Packages

- [`@shapeshift-labs/frontier`](https://www.npmjs.com/package/@shapeshift-labs/frontier): core JSON diff/apply primitives.
- [`@shapeshift-labs/frontier-codec`](https://www.npmjs.com/package/@shapeshift-labs/frontier-codec): patch serialization, binary frames, canonical JSON, and patch-history codecs.
- [`@shapeshift-labs/frontier-query`](https://www.npmjs.com/package/@shapeshift-labs/frontier-query): shared query-key, selector path, condition, identity, and table-schema primitives.
- [`@shapeshift-labs/frontier-mutation`](https://www.npmjs.com/package/@shapeshift-labs/frontier-mutation): explicit mutation and selector plans that can use engine-backed diff planning.

Package source repositories:

- [`siliconjungle/-shapeshift-labs-frontier`](https://github.com/siliconjungle/-shapeshift-labs-frontier)
- [`siliconjungle/-shapeshift-labs-frontier-codec`](https://github.com/siliconjungle/-shapeshift-labs-frontier-codec)
- [`siliconjungle/-shapeshift-labs-frontier-query`](https://github.com/siliconjungle/-shapeshift-labs-frontier-query)
- [`siliconjungle/-shapeshift-labs-frontier-mutation`](https://github.com/siliconjungle/-shapeshift-labs-frontier-mutation)

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

## Validation

```sh
npm test
npm run fuzz
npm run bench
npm run pack:dry
```

The package test suite covers root and subpath imports, schema diff/apply replay, profile snapshots, history planning, encoded history replay, and the absence of state/CRDT exports. The fuzzer covers schema and adaptive profile round-trips over record-array and object-shaped JSON.

## Benchmarks

Run the package-local benchmark:

```sh
npm run bench
```

Latest local package-gate run on Node v26.1.0, darwin arm64, 3 rounds:

| Fixture | Median | p95 |
| --- | ---: | ---: |
| Engine schema diff, 1k rows | 16.67 us | 17.45 us |
| Engine apply via core patch | 0.58 us | 0.59 us |
| Engine equality no-op | 9.32 us | 9.44 us |
| Engine history encode/decode/apply | 3.97 us | 4.22 us |

These are Frontier-only package measurements, not competitor comparisons.

## License

MIT. See [LICENSE](./LICENSE).
