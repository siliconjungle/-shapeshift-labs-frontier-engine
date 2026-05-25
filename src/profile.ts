import type {
  CodecProfilePlan,
  CrdtProfilePlan,
  DiffProfilePlan,
  EqualityProfilePlan,
  HistoryProfilePlan,
  JsonPath,
  ObjectKey,
  ProfilePlans,
  StateProfilePlan
} from './types.js';

export type HistoryPlanStrategy = NonNullable<HistoryProfilePlan['strategy']>;

export interface EngineProfilePlanSnapshot {
  settings?: Record<string, unknown> | null;
  schemaCount: number;
  schemaPaths?: JsonPath[];
  adaptivePlan: boolean;
  historyStrategy?: HistoryPlanStrategy | null;
}

export interface StateProfilePlanStats {
  watches: number;
  exactWatches: number;
  wildcardWatches: number;
  fieldWatches: number;
  rangeWatches: number;
}

export function readProfilePlans(profile: { plans?: ProfilePlans } | undefined | null, label = 'profile'): ProfilePlans | undefined {
  if (profile === undefined || profile === null || profile.plans === undefined) return undefined;
  return normalizeProfilePlans(profile.plans, label + ' plans');
}

export function cloneProfilePlans(plans: ProfilePlans | undefined): ProfilePlans | undefined {
  return plans === undefined ? undefined : normalizeProfilePlans(plans, 'profile plans');
}

export function mergeProfilePlans(...items: Array<ProfilePlans | undefined>): ProfilePlans | undefined {
  let out: ProfilePlans | undefined;
  for (let i = 0, length = items.length; i < length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    const normalized = normalizeProfilePlans(item, 'profile plans');
    if (out === undefined) out = {};
    if (normalized.diff !== undefined) out.diff = { ...(out.diff || {}), ...normalized.diff };
    if (normalized.equality !== undefined) out.equality = { ...(out.equality || {}), ...normalized.equality };
    if (normalized.history !== undefined) out.history = { ...(out.history || {}), ...normalized.history };
    if (normalized.codec !== undefined) out.codec = { ...(out.codec || {}), ...normalized.codec };
    if (normalized.state !== undefined) out.state = { ...(out.state || {}), ...normalized.state };
    if (normalized.crdt !== undefined) out.crdt = { ...(out.crdt || {}), ...normalized.crdt };
  }
  return out === undefined || Object.keys(out).length === 0 ? undefined : out;
}

export function createEngineProfilePlansSnapshot(
  inherited: ProfilePlans | undefined,
  snapshot: EngineProfilePlanSnapshot
): ProfilePlans | undefined {
  const generated: ProfilePlans = {
    diff: createDiffPlan(snapshot),
    equality: createEqualityPlan(snapshot),
    history: {
      strategy: snapshot.historyStrategy || 'auto'
    },
    codec: {
      patch: 'auto',
      history: 'binary'
    }
  };
  return mergeProfilePlans(inherited, generated);
}

export function createStateProfilePlansSnapshot(
  inherited: ProfilePlans | undefined,
  stats: StateProfilePlanStats
): ProfilePlans | undefined {
  const state: StateProfilePlan = {
    routing: 'patch-router',
    apply: 'owned-mutable'
  };
  if (stats.watches !== 0) {
    state.watches = stats.watches;
    if (stats.exactWatches !== 0) state.exactWatches = stats.exactWatches;
    if (stats.wildcardWatches !== 0) state.wildcardWatches = stats.wildcardWatches;
    if (stats.fieldWatches !== 0) state.fieldWatches = stats.fieldWatches;
    if (stats.rangeWatches !== 0) state.rangeWatches = stats.rangeWatches;
  }
  return mergeProfilePlans(inherited, { state });
}

export function createCrdtProfilePlansSnapshot(inherited: ProfilePlans | undefined, nativeTextProfileCount: number): ProfilePlans | undefined {
  const crdt: CrdtProfilePlan = {
    update: nativeTextProfileCount === 0 ? 'binary' : 'columnar-text',
    text: nativeTextProfileCount === 0 ? 'chunked-ids' : 'native-piece'
  };
  return mergeProfilePlans(inherited, {
    codec: { crdt: crdt.update === 'columnar-text' ? 'columnar-text' : 'binary' },
    crdt
  });
}

function createDiffPlan(snapshot: EngineProfilePlanSnapshot): DiffProfilePlan {
  const plan: DiffProfilePlan = {
    strategy: snapshot.schemaCount === 0
      ? 'structural'
      : snapshot.adaptivePlan
        ? 'adaptive-schema'
        : 'schema',
    schemaCount: snapshot.schemaCount
  };
  if (snapshot.schemaPaths !== undefined && snapshot.schemaPaths.length !== 0) {
    plan.paths = clonePathList(snapshot.schemaPaths);
  }
  return plan;
}

function createEqualityPlan(snapshot: EngineProfilePlanSnapshot): EqualityProfilePlan {
  const settings = snapshot.settings || {};
  if (isObjectKey(settings.versionKey)) {
    return { strategy: 'token', token: 'versionKey', key: settings.versionKey };
  }
  if (isObjectKey(settings.fingerprintKey)) {
    return { strategy: 'token', token: 'fingerprintKey', key: settings.fingerprintKey };
  }
  return {
    strategy: snapshot.schemaCount === 0 ? 'fast-json' : 'schema'
  };
}

function normalizeProfilePlans(value: unknown, label: string): ProfilePlans {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(label + ' must be an object');
  }
  const input = value as ProfilePlans;
  const out: ProfilePlans = {};
  if (input.diff !== undefined) out.diff = normalizeDiffPlan(input.diff, label + '.diff');
  if (input.equality !== undefined) out.equality = normalizeEqualityPlan(input.equality, label + '.equality');
  if (input.history !== undefined) out.history = normalizeHistoryPlan(input.history, label + '.history');
  if (input.codec !== undefined) out.codec = normalizeCodecPlan(input.codec, label + '.codec');
  if (input.state !== undefined) out.state = normalizeStatePlan(input.state, label + '.state');
  if (input.crdt !== undefined) out.crdt = normalizeCrdtPlan(input.crdt, label + '.crdt');
  return out;
}

function normalizeDiffPlan(value: unknown, label: string): DiffProfilePlan {
  const input = readPlanObject<DiffProfilePlan>(value, label);
  const out: DiffProfilePlan = {};
  if (input.strategy !== undefined) {
    if (input.strategy !== 'structural' && input.strategy !== 'schema' && input.strategy !== 'adaptive-schema') {
      throw new TypeError(label + '.strategy is invalid');
    }
    out.strategy = input.strategy;
  }
  if (input.schemaCount !== undefined) out.schemaCount = readNonNegativeInteger(input.schemaCount, label + '.schemaCount');
  if (input.paths !== undefined) out.paths = clonePathList(input.paths);
  return out;
}

function normalizeEqualityPlan(value: unknown, label: string): EqualityProfilePlan {
  const input = readPlanObject<EqualityProfilePlan>(value, label);
  const out: EqualityProfilePlan = {};
  if (input.strategy !== undefined) {
    if (input.strategy !== 'fast-json' && input.strategy !== 'schema' && input.strategy !== 'token') {
      throw new TypeError(label + '.strategy is invalid');
    }
    out.strategy = input.strategy;
  }
  if (input.token !== undefined) {
    if (input.token !== 'versionKey' && input.token !== 'fingerprintKey') throw new TypeError(label + '.token is invalid');
    out.token = input.token;
  }
  if (input.key !== undefined) {
    if (!isObjectKey(input.key)) throw new TypeError(label + '.key must be a string or number');
    out.key = input.key;
  }
  return out;
}

function normalizeHistoryPlan(value: unknown, label: string): HistoryProfilePlan {
  const input = readPlanObject<HistoryProfilePlan>(value, label);
  const out: HistoryProfilePlan = {};
  if (input.strategy !== undefined) {
    if (
      input.strategy !== 'auto' &&
      input.strategy !== 'string-append' &&
      input.strategy !== 'row-object-assign' &&
      input.strategy !== 'object-assign' &&
      input.strategy !== 'scalar-object'
    ) {
      throw new TypeError(label + '.strategy is invalid');
    }
    out.strategy = input.strategy;
  }
  return out;
}

function normalizeCodecPlan(value: unknown, label: string): CodecProfilePlan {
  const input = readPlanObject<CodecProfilePlan>(value, label);
  const out: CodecProfilePlan = {};
  if (input.patch !== undefined) {
    if (input.patch !== 'auto' && input.patch !== 'json' && input.patch !== 'binary') throw new TypeError(label + '.patch is invalid');
    out.patch = input.patch;
  }
  if (input.history !== undefined) {
    if (input.history !== 'auto' && input.history !== 'binary' && input.history !== 'binary-columnar') {
      throw new TypeError(label + '.history is invalid');
    }
    out.history = input.history;
  }
  if (input.crdt !== undefined) {
    if (input.crdt !== 'auto' && input.crdt !== 'json' && input.crdt !== 'binary' && input.crdt !== 'columnar-text') {
      throw new TypeError(label + '.crdt is invalid');
    }
    out.crdt = input.crdt;
  }
  return out;
}

function normalizeStatePlan(value: unknown, label: string): StateProfilePlan {
  const input = readPlanObject<StateProfilePlan>(value, label);
  const out: StateProfilePlan = {};
  if (input.routing !== undefined) {
    if (input.routing !== 'patch-router') throw new TypeError(label + '.routing is invalid');
    out.routing = input.routing;
  }
  if (input.apply !== undefined) {
    if (input.apply !== 'owned-mutable' && input.apply !== 'immutable') throw new TypeError(label + '.apply is invalid');
    out.apply = input.apply;
  }
  copyOptionalNonNegativeInteger(out, input, 'watches', label);
  copyOptionalNonNegativeInteger(out, input, 'exactWatches', label);
  copyOptionalNonNegativeInteger(out, input, 'wildcardWatches', label);
  copyOptionalNonNegativeInteger(out, input, 'fieldWatches', label);
  copyOptionalNonNegativeInteger(out, input, 'rangeWatches', label);
  return out;
}

function normalizeCrdtPlan(value: unknown, label: string): CrdtProfilePlan {
  const input = readPlanObject<CrdtProfilePlan>(value, label);
  const out: CrdtProfilePlan = {};
  if (input.update !== undefined) {
    if (input.update !== 'auto' && input.update !== 'json' && input.update !== 'binary' && input.update !== 'columnar-text') {
      throw new TypeError(label + '.update is invalid');
    }
    out.update = input.update;
  }
  if (input.text !== undefined) {
    if (input.text !== 'chunked-ids' && input.text !== 'native-piece') throw new TypeError(label + '.text is invalid');
    out.text = input.text;
  }
  return out;
}

function readPlanObject<T>(value: unknown, label: string): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(label + ' must be an object');
  return value as T;
}

function clonePathList(paths: JsonPath[]): JsonPath[] {
  if (!Array.isArray(paths)) throw new TypeError('profile plan paths must be an array');
  const out = new Array<JsonPath>(paths.length);
  for (let i = 0, length = paths.length; i < length; i++) {
    const path = paths[i];
    if (!Array.isArray(path)) throw new TypeError('profile plan path must be an array');
    const cloned = new Array<string | number>(path.length);
    for (let j = 0, pathLength = path.length; j < pathLength; j++) {
      const segment = path[j];
      if (!isObjectKey(segment)) throw new TypeError('profile plan path segments must be strings or numbers');
      cloned[j] = segment;
    }
    out[i] = cloned;
  }
  return out;
}

function copyOptionalNonNegativeInteger(out: StateProfilePlan, input: StateProfilePlan, key: keyof StateProfilePlan, label: string): void {
  const value = input[key];
  if (value === undefined) return;
  (out as any)[key] = readNonNegativeInteger(value, label + '.' + key);
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(label + ' must be a non-negative safe integer');
  return value as number;
}

function isObjectKey(value: unknown): value is ObjectKey {
  return typeof value === 'string' || typeof value === 'number';
}
