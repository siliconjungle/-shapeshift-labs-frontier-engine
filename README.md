# Frontier Engine

Reserved package name for the future Frontier planned diff engine package.

This package is not ready for production use. It exists so the package and repository names are reserved while stateful diff planning, adaptive profiles, schema plans, and engine/history boundaries are finalized.

- npm: [`@shapeshift-labs/frontier-engine`](https://www.npmjs.com/package/@shapeshift-labs/frontier-engine)
- source: [`siliconjungle/-shapeshift-labs-frontier-engine`](https://github.com/siliconjungle/-shapeshift-labs-frontier-engine)
- core package: [`@shapeshift-labs/frontier`](https://www.npmjs.com/package/@shapeshift-labs/frontier)
- codec package: [`@shapeshift-labs/frontier-codec`](https://www.npmjs.com/package/@shapeshift-labs/frontier-codec)
- license: MIT

## Intended Scope

When this package graduates from placeholder status, it is expected to contain:

- `createDiffEngine()` and stateful planned diff execution;
- adaptive shape learning and schema/profile planning;
- reusable engine caches and failed-plan thresholds;
- profile plan snapshots shared by state, history, codec, and CRDT layers;
- engine-level history helpers that delegate byte formats to `frontier-codec`.

It should sit above `@shapeshift-labs/frontier` and use `@shapeshift-labs/frontier-codec` where patch-history serialization is needed. It should stay separate from state subscriptions, CRDT actors/updates, sync providers, logging, rich text, and storage-specific event logs.

## Current Status

Use [`@shapeshift-labs/frontier`](https://www.npmjs.com/package/@shapeshift-labs/frontier) for the stable JSON diff/apply core and [`@shapeshift-labs/frontier-codec`](https://www.npmjs.com/package/@shapeshift-labs/frontier-codec) for patch transport codecs.

The engine package is reserved only. No runtime API is exported yet.

## Package Family

Published or active packages:

- [`@shapeshift-labs/frontier`](https://www.npmjs.com/package/@shapeshift-labs/frontier)
- [`@shapeshift-labs/frontier-codec`](https://www.npmjs.com/package/@shapeshift-labs/frontier-codec)
- [`@shapeshift-labs/frontier-mutation`](https://www.npmjs.com/package/@shapeshift-labs/frontier-mutation)

Reserved future packages:

- `@shapeshift-labs/frontier-state`
- `@shapeshift-labs/frontier-crdt`
- `@shapeshift-labs/frontier-crdt-sync`
- `@shapeshift-labs/frontier-richtext`
- `@shapeshift-labs/frontier-logging`
- `@shapeshift-labs/frontier-state-cache`
- `@shapeshift-labs/frontier-event-log`
- `@shapeshift-labs/frontier-schema`

## License

MIT. See [LICENSE](./LICENSE).
