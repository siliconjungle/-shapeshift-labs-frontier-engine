import {
  OP_SET,
  OP_REMOVE,
  OP_TRUNCATE,
  OP_APPEND,
  OP_ASSIGN,
  OP_STRING_SPLICE,
  OP_ARRAY_SPLICE,
  OP_ARRAY_MOVE,
  OP_STRING_COPY,
  OP_ARRAY_ASSIGN,
  OP_ARRAY_OBJECT_ASSIGN,
  OP_ARRAY_TUPLE_ASSIGN,
  OP_ARRAY_OBJECT_FIELD_ASSIGN,
  OP_SCALAR_ARRAY_REPLACE,
  OP_ARRAY_TWO_FIELD_INSERT
} from '@shapeshift-labs/frontier/constants';
import { diffInto as computeDiffInto } from '@shapeshift-labs/frontier/diff';
import { cloneJson } from '@shapeshift-labs/frontier/clone';
import { equalsJsonFast } from '@shapeshift-labs/frontier/equal';
import {
  applyEncodedPatchHistory,
  applyPatchHistory,
  createPatchHistoryBuilder,
  decodePatchHistory,
  encodePatchHistory
} from '@shapeshift-labs/frontier-codec/history';
import {
  createEngineProfilePlansSnapshot,
  readProfilePlans,
  type HistoryPlanStrategy
} from './profile.js';
import type {
  DiffEngine,
  DiffOptions,
  DiffProfile,
  EngineOptions,
  EngineProfileSettings,
  JsonPath,
  JsonObject,
  JsonValue,
  NumericQuantizationRule,
  ObjectKey,
  Patch,
  PatchOperation,
  PatchHistoryBuilder,
  PatchHistoryCodecOptions,
  ProfilePlans,
  SchemaField,
  SingleSchema,
  TrainingSample
} from './types.js';

const DEFAULT_MAX_ENTRIES = 256;
const MAX_PAIR_SIGNATURES = 8;
const DEFAULT_ADAPTIVE_THRESHOLD = 1;
const ADAPTIVE_SAMPLE_LIMIT = 16;
const ADAPTIVE_RECORD_FIELD_MIN = 2;
const ADAPTIVE_RECORD_CELL_MIN = 96;
const ADAPTIVE_OBJECT_FIELD_MIN = 32;
const ADAPTIVE_PATH_OBJECT_FIELD_MIN = 8;
const ADAPTIVE_DEFER_OBJECT_FIELD_MIN = 128;
const BITMASK_RECORD_FIELD_MAX = 24;
const ADAPTIVE_NESTED_FIELD_DEPTH = 2;
const TRAINING_MAX_DEPTH = 4;
const TRAINING_MAX_SCHEMAS = 16;
const COMPILED_PLAN_CACHE_LIMIT = 128;
const ADAPTIVE_FAILED_PLAN_SIGNATURE_LIMIT = 32;
const HISTORY_OBJECT_ASSIGN_FIELD_MIN = 8;
const HISTORY_OBJECT_ASSIGN_GROUP_MAX = 16;
const HISTORY_OBJECT_ASSIGN_TOTAL_KEY_MAX = 512;
const PROFILE_VERSION = 1;
const DEFERRED_WIDE_ROOT_OBJECT_SIGNATURE = '\u0003wide-root-object';
const hasOwn = Object.prototype.hasOwnProperty;
const flatRecordArrayDiffCache = new Map();
const flatRecordArrayBitmaskDiffCache = new Map();
const nestedRecordArrayDiffCache = new Map();
const flatObjectDiffCache = new Map();
const nestedObjectDiffCache = new Map();
const flatRecordArrayEqualsCache = new Map();
const flatObjectEqualsCache = new Map();
const nestedRecordArrayEqualsCache = new Map();
const nestedObjectEqualsCache = new Map();

type NormalizedObjectPlanSchema = {
  type: 'object';
  fields: SchemaField[];
  path?: JsonPath;
  exact?: true;
};

type NormalizedRecordArrayPlanSchema = {
  type: 'array';
  item: {
    type: 'object';
    fields: SchemaField[];
  };
  path?: JsonPath;
  key?: ObjectKey;
  exact?: true;
};

type ProfileSettingsSnapshot = EngineProfileSettings & Record<string, unknown>;

type QuantizationContext = {
  rules: NumericQuantizationRule[];
};

type AdaptiveShape =
  | {
      kind: 'recordArray';
      fields: SchemaField[];
      rowCount: number;
      source: unknown[];
      target: unknown[];
      path: JsonPath;
    }
  | {
      kind: 'object';
      fields: SchemaField[];
      path: JsonPath;
    };

type TrainingEntry = {
  shape: AdaptiveShape;
  hits: number;
  score: number;
};

type HistoryAssignGroup = {
  path: JsonPath;
  keys: string[];
};

type RowObjectHistoryChange = {
  arrayPath: JsonPath;
  indexes: number[];
  fields: string[];
  setOps: Array<[JsonPath, JsonValue]>;
  target: JsonValue;
};

type RowObjectHistoryCollector = {
  arrayPath: JsonPath | null;
  indexes: number[];
  fields: string[];
  setOps: Array<[JsonPath, JsonValue]>;
};

export function createDiffEngine(defaultOptions?: EngineOptions): DiffEngine {
  const rawBaseOptions = readOptions(defaultOptions, 'default options');
  const initialProfile = readProfile(rawBaseOptions && rawBaseOptions.profile);
  const baseOptions = omitProfileOption(rawBaseOptions);
  let profileOptions = initialProfile === null ? undefined : initialProfile.settings;
  let effectiveOptions = mergeOptions(profileOptions, baseOptions);
  let maxEntries = readMaxEntries(effectiveOptions);
  validateAdaptiveOption(effectiveOptions);
  const baseSchemaPlan = baseOptions && baseOptions.schema !== undefined && baseOptions.schema !== null
    ? compileSchemaPlan(baseOptions.schema)
    : null;
  let profilePlan = initialProfile === null ? null : initialProfile.plan;
  let profilePlans = initialProfile === null ? undefined : initialProfile.plans;
  let learnedHistoryStrategy: HistoryPlanStrategy | null = readHistoryPlanStrategy(profilePlans);
  let adaptive = createAdaptiveState(effectiveOptions);
  let pairCache = new WeakMap();
  const tokenEntries = [];
  const plannedHistoryStrategyOut: { value: HistoryPlanStrategy | null } = { value: null };

  function diff(source: JsonValue, target: JsonValue, options?: EngineOptions): Patch {
    return diffInto(source, target, [], options);
  }

  function diffHistory(initial: JsonValue, states: JsonValue[], options?: DiffOptions): Patch[] {
    if (!Array.isArray(states)) {
      throw new TypeError('diffHistory(initial, states) requires states to be an array');
    }
    if (options === undefined || options === null) {
      plannedHistoryStrategyOut.value = null;
      const plannedHistory = tryPlannedDiffHistory(initial, states, learnedHistoryStrategy, plannedHistoryStrategyOut);
      if (plannedHistory !== null) {
        if (plannedHistoryStrategyOut.value !== null) learnedHistoryStrategy = plannedHistoryStrategyOut.value;
        return plannedHistory;
      }
    }
    const patches = new Array<Patch>(states.length);
    let source = initial;
    for (let i = 0, length = states.length; i < length; i++) {
      const target = states[i];
      patches[i] = diff(source, target, options);
      source = target;
    }
    return patches;
  }

  function encodeHistory(patches: Patch[], options?: PatchHistoryCodecOptions): Uint8Array {
    return encodePatchHistory(patches, options);
  }

  function decodeHistory(bytes: ArrayBuffer | ArrayBufferView, options?: PatchHistoryCodecOptions): Patch[] {
    return decodePatchHistory(bytes, options);
  }

  function applyHistory(source: JsonValue, patches: Patch[], options?: PatchHistoryCodecOptions): JsonValue {
    return applyPatchHistory(source, patches, options);
  }

  function applyEncodedHistory(source: JsonValue, bytes: ArrayBuffer | ArrayBufferView, options?: PatchHistoryCodecOptions): JsonValue {
    return applyEncodedPatchHistory(source, bytes, options);
  }

  function createHistoryBuilder(): PatchHistoryBuilder {
    return createPatchHistoryBuilder();
  }

  function diffInto(source: JsonValue, target: JsonValue, patch: Patch, options?: EngineOptions): Patch {
    if (!Array.isArray(patch)) {
      throw new TypeError('patch output must be an array');
    }

    const mergedOptions = mergeOptions(effectiveOptions, options);
    validateAdaptiveOption(mergedOptions);
    const cacheState = readCacheState(source, target, mergedOptions);
    const canLearnAdaptive = !hasAvailableSchemaPlan(mergedOptions, baseSchemaPlan, profilePlan) && shouldUseEnginePlan(mergedOptions);
    if (canLearnAdaptive && readAdaptivePlan(adaptive) === null && observeAdaptiveShape(adaptive, source, target)) {
      pairCache = new WeakMap();
      tokenEntries.length = 0;
    }

    if (cacheState !== null && maxEntries !== 0) {
      const pairEntry = lookupPairEntry(pairCache, source, target, cacheState);
      if (pairEntry !== null) {
        return clonePatchInto(pairEntry.patch, patch);
      }

      const tokenEntry = lookupTokenEntry(tokenEntries, cacheState);
      if (tokenEntry !== null) {
        storePairEntry(pairCache, source, target, tokenEntry);
        return clonePatchInto(tokenEntry.patch, patch);
      }
    }

    patch.length = 0;

    let configuredPlan = null;
    let adaptivePlan = null;
    if (shouldUseEnginePlan(mergedOptions)) {
      configuredPlan = baseSchemaPlan || readSchemaPlan(mergedOptions) || profilePlan;
      if (configuredPlan === null) {
        adaptivePlan = readAdaptivePlan(adaptive);
      }
    }
    const plan = configuredPlan || adaptivePlan;
    const skipAdaptivePlan = adaptivePlan !== null && hasAdaptiveFailedPlan(adaptive, adaptivePlan, source, target);
    let planned = false;
    if (plan !== null && !skipAdaptivePlan) {
      planned = tryPlannedDiff(plan, source, target, patch, mergedOptions);
      if (!planned && adaptivePlan !== null) {
        rememberAdaptiveFailedPlan(adaptive, adaptivePlan, source, target);
      }
    }
    if (!planned && !skipAdaptivePlan && canLearnAdaptive && plan !== null && observeAdaptiveShape(adaptive, source, target)) {
      pairCache = new WeakMap();
      tokenEntries.length = 0;
      patch.length = 0;
      const retryPlan = readAdaptivePlan(adaptive);
      if (retryPlan !== null && !hasAdaptiveFailedPlan(adaptive, retryPlan, source, target)) {
        planned = tryPlannedDiff(retryPlan, source, target, patch, mergedOptions);
        if (!planned) {
          rememberAdaptiveFailedPlan(adaptive, retryPlan, source, target);
        }
      }
    }
    if (!planned) {
      computeDiffInto(source, target, patch, mergedOptions);
    } else {
      if (
        canLearnAdaptive &&
        adaptivePlan !== null &&
        !planCoversRoot(adaptivePlan) &&
        observeAdaptiveShape(adaptive, source, target)
      ) {
        pairCache = new WeakMap();
        tokenEntries.length = 0;
      }
      compactPlannedArrayObjectSetRuns(patch);
    }

    if (cacheState !== null && maxEntries !== 0) {
      const entry = {
        sourceToken: cacheState.sourceToken,
        targetToken: cacheState.targetToken,
        signature: cacheState.signature,
        patch: clonePatch(patch)
      };
      storePairEntry(pairCache, source, target, entry);
      storeTokenEntry(tokenEntries, entry, maxEntries);
    }

    return patch;
  }

  function equals(source: JsonValue, target: JsonValue, options?: EngineOptions): boolean {
    const mergedOptions = mergeOptions(effectiveOptions, options);
    validateAdaptiveOption(mergedOptions);

    const cacheState = readCacheState(source, target, mergedOptions);
    if (cacheState !== null && cacheState.sourceToken === cacheState.targetToken) return true;

    const canLearnAdaptive = !hasAvailableSchemaPlan(mergedOptions, baseSchemaPlan, profilePlan) && shouldUseEnginePlan(mergedOptions);
    if (canLearnAdaptive && readAdaptivePlan(adaptive) === null) {
      observeAdaptiveShape(adaptive, source, target);
    }

    if (shouldUseEnginePlan(mergedOptions)) {
      const configuredPlan = baseSchemaPlan || readSchemaPlan(mergedOptions) || profilePlan;
      const adaptivePlan = configuredPlan === null ? readAdaptivePlan(adaptive) : null;
      const plan = configuredPlan || adaptivePlan;
      if (plan !== null && !(adaptivePlan !== null && hasAdaptiveFailedPlan(adaptive, adaptivePlan, source, target))) {
        const planned = tryPlannedEquals(plan, source, target, mergedOptions);
        if (planned === true) return true;
      }
    }

    return equalsJsonFast(source, target, mergedOptions);
  }

  function clear() {
    pairCache = new WeakMap();
    tokenEntries.length = 0;
    clearAdaptiveState(adaptive);
  }

  function train(samples: TrainingSample[]): DiffProfile {
    if (adaptive === null || !adaptive.enabled) {
      throw new TypeError('train(samples) requires createDiffEngine({ adaptive: true })');
    }
    const plan = trainProfilePlan(samples, adaptive.recordKeyCandidates);
    if (plan !== null) {
      adaptive.plan = plan;
      adaptive.candidates.clear();
      adaptive.learnedKeys.clear();
      adaptive.rejectedKeys.clear();
      adaptive.deferredObjectSignatures.clear();
      clearAdaptiveFailedPlanPairs(adaptive);
    }
    pairCache = new WeakMap();
    tokenEntries.length = 0;
    return getProfile();
  }

  function getProfile(): DiffProfile {
    return createProfileSnapshot(effectiveOptions, maxEntries, baseSchemaPlan, profilePlan, profilePlans, adaptive, learnedHistoryStrategy);
  }

  function loadProfile(profile?: DiffProfile | null): void {
    const state = readProfile(profile);
    profilePlan = state === null ? null : state.plan;
    profilePlans = state === null ? undefined : state.plans;
    learnedHistoryStrategy = readHistoryPlanStrategy(profilePlans);
    profileOptions = state === null ? undefined : state.settings;
    effectiveOptions = mergeOptions(profileOptions, baseOptions);
    maxEntries = readMaxEntries(effectiveOptions);
    validateAdaptiveOption(effectiveOptions);
    adaptive = createAdaptiveState(effectiveOptions);
    pairCache = new WeakMap();
    tokenEntries.length = 0;
  }

  return {
    diff,
    diffInto,
    equals,
    diffHistory,
    encodeHistory,
    decodeHistory,
    applyHistory,
    applyEncodedHistory,
    createHistoryBuilder,
    clear,
    train,
    getProfile,
    loadProfile
  };
}

function tryPlannedDiffHistory(
  initial: JsonValue,
  states: JsonValue[],
  preferred: HistoryPlanStrategy | null | undefined,
  strategyOut: { value: HistoryPlanStrategy | null }
): Patch[] | null {
  if (states.length === 0) return [];
  if (preferred !== undefined && preferred !== null && preferred !== 'auto') {
    const preferredPatches = tryDiffHistoryStrategy(preferred, initial, states);
    if (preferredPatches !== null) return preferredPatches;
  }

  const stringAppend = tryStringAppendDiffHistory(initial, states);
  if (stringAppend !== null) {
    strategyOut.value = 'string-append';
    return stringAppend;
  }

  const rowObjectAssign = tryRowObjectAssignDiffHistory(initial, states);
  if (rowObjectAssign !== null) {
    strategyOut.value = 'row-object-assign';
    return rowObjectAssign;
  }

  const objectAssign = tryObjectAssignDiffHistory(initial, states);
  if (objectAssign !== null) {
    strategyOut.value = 'object-assign';
    return objectAssign;
  }

  const scalarObject = tryScalarObjectDiffHistory(initial, states);
  if (scalarObject !== null) {
    strategyOut.value = 'scalar-object';
    return scalarObject;
  }

  return null;
}

function tryDiffHistoryStrategy(strategy: HistoryPlanStrategy, initial: JsonValue, states: JsonValue[]): Patch[] | null {
  if (strategy === 'string-append') return tryStringAppendDiffHistory(initial, states);
  if (strategy === 'row-object-assign') return tryRowObjectAssignDiffHistory(initial, states);
  if (strategy === 'object-assign') return tryObjectAssignDiffHistory(initial, states);
  if (strategy === 'scalar-object') return tryScalarObjectDiffHistory(initial, states);
  return null;
}

function tryStringAppendDiffHistory(initial: JsonValue, states: JsonValue[]): Patch[] | null {
  const firstPath = findOnlyStringAppendPath(initial, states[0]);
  if (firstPath === null) return null;

  const patches = new Array<Patch>(states.length);
  let previous = initial;
  for (let i = 0, length = states.length; i < length; i++) {
    const target = states[i];
    if (!isOnlyStringAppendAtPath(previous, target, firstPath)) return null;
    const sourceText = readHistoryPath(previous, firstPath);
    const targetText = readHistoryPath(target, firstPath);
    if (typeof sourceText !== 'string' || typeof targetText !== 'string') return null;
    patches[i] = [[OP_STRING_SPLICE, firstPath.slice(), sourceText.length, 0, targetText.slice(sourceText.length)]];
    previous = target;
  }
  return patches;
}

function isOnlyStringAppendAtPath(source: JsonValue, target: JsonValue, path: JsonPath): boolean {
  return isOnlyStringAppendAtPathInto(source, target, path, 0);
}

function isOnlyStringAppendAtPathInto(source: JsonValue, target: JsonValue, path: JsonPath, depth: number): boolean {
  if (depth === path.length) {
    return typeof source === 'string' &&
      typeof target === 'string' &&
      isStringAppend(source, target);
  }

  if (!isHistoryPlainObject(source) || !isHistoryPlainObject(target)) return false;

  const sourceKeys = Object.keys(source);
  const targetKeys = Object.keys(target);
  if (sourceKeys.length !== targetKeys.length) return false;

  const segment = path[depth];
  let found = false;
  for (let i = 0, length = sourceKeys.length; i < length; i++) {
    const key = sourceKeys[i];
    if (targetKeys[i] !== key || !hasOwn.call(target, key)) return false;
    if (key === segment) {
      if (!isOnlyStringAppendAtPathInto(source[key], target[key], path, depth + 1)) return false;
      found = true;
    } else if (!sameHistoryScalarOrRef(source[key], target[key])) {
      return false;
    }
  }
  return found;
}

function findOnlyStringAppendPath(source: JsonValue, target: JsonValue): JsonPath | null {
  const out: JsonPath = [];
  return findOnlyStringAppendPathInto(source, target, out) ? out : null;
}

function findOnlyStringAppendPathInto(source: JsonValue, target: JsonValue, out: JsonPath): boolean {
  if (source === target) {
    if (source !== 0 || 1 / (source as number) === 1 / (target as number)) return false;
  }
  if (typeof source === 'string' && typeof target === 'string') {
    return isStringAppend(source, target);
  }
  if (!isHistoryPlainObject(source) || !isHistoryPlainObject(target)) return false;

  const sourceKeys = Object.keys(source);
  const targetKeys = Object.keys(target);
  if (sourceKeys.length !== targetKeys.length) return false;

  let found = false;
  for (let i = 0, length = sourceKeys.length; i < length; i++) {
    const key = sourceKeys[i];
    if (targetKeys[i] !== key || !hasOwn.call(target, key)) return false;
    const sourceValue = source[key];
    const targetValue = target[key];
    if (sameHistoryScalarOrRef(sourceValue, targetValue)) continue;
    const depth = out.length;
    out[depth] = key;
    if (!findOnlyStringAppendPathInto(sourceValue, targetValue, out) || found) return false;
    out.length = depth + 1;
    found = true;
  }
  return found;
}

function isStringAppend(source: string, target: string): boolean {
  return target.length > source.length && target.slice(0, source.length) === source;
}

function tryRowObjectAssignDiffHistory(initial: JsonValue, states: JsonValue[]): Patch[] | null {
  if (states.length < 8) return null;

  const changes = new Array<RowObjectHistoryChange>(states.length);
  const firstChange = collectRowObjectHistoryChange(initial, states[0]);
  if (firstChange === null || firstChange.indexes.length === 0 || firstChange.fields.length === 0) return null;

  const arrayPath = firstChange.arrayPath;
  const setPaths = firstChange.setOps.map((op) => op[0]);
  const fields = firstChange.fields.slice();
  changes[0] = firstChange;
  let previous = initial;
  for (let i = 1, length = states.length; i < length; i++) {
    previous = states[i - 1];
    const target = states[i];
    const change = collectRowObjectHistoryChange(previous, target);
    if (change === null || change.indexes.length === 0) return null;
    if (!sameHistoryPath(arrayPath, change.arrayPath) || !sameHistoryPathList(setPaths, change.setOps.map((op) => op[0]))) {
      return null;
    }
    for (let fieldIndex = 0, fieldCount = change.fields.length; fieldIndex < fieldCount; fieldIndex++) {
      addUniqueHistoryField(fields, change.fields[fieldIndex]);
    }
    changes[i] = change;
  }

  if (fields.length > BITMASK_RECORD_FIELD_MAX) return null;

  const patches = new Array<Patch>(states.length);
  for (let i = 0, length = changes.length; i < length; i++) {
    const change = changes[i];
    const rows = readHistoryPath(change.target, arrayPath);
    if (!Array.isArray(rows)) return null;

    let firstOp: PatchOperation;
    if (fields.length === 1) {
      const field = fields[0];
      const values = new Array<JsonValue>(change.indexes.length);
      for (let rowOffset = 0, rowCount = change.indexes.length; rowOffset < rowCount; rowOffset++) {
        const row = rows[change.indexes[rowOffset]];
        if (!isHistoryPlainObject(row) || !hasOwn.call(row, field)) return null;
        values[rowOffset] = row[field];
      }
      firstOp = [OP_ARRAY_OBJECT_FIELD_ASSIGN, arrayPath.slice(), change.indexes.slice(), [[field]], values];
    } else {
      const assigns = new Array<JsonObject>(change.indexes.length);
      for (let rowOffset = 0, rowCount = change.indexes.length; rowOffset < rowCount; rowOffset++) {
        const row = rows[change.indexes[rowOffset]];
        if (!isHistoryPlainObject(row)) return null;
        const assign: JsonObject = {};
        for (let fieldIndex = 0, fieldCount = fields.length; fieldIndex < fieldCount; fieldIndex++) {
          const field = fields[fieldIndex];
          if (!hasOwn.call(row, field)) return null;
          assign[field] = row[field];
        }
        assigns[rowOffset] = assign;
      }
      firstOp = [OP_ARRAY_OBJECT_ASSIGN, arrayPath.slice(), change.indexes.slice(), assigns];
    }

    const patch = new Array<PatchOperation>(1 + change.setOps.length);
    patch[0] = firstOp;
    for (let setIndex = 0, setCount = change.setOps.length; setIndex < setCount; setIndex++) {
      const setOp = change.setOps[setIndex];
      patch[setIndex + 1] = [OP_SET, setOp[0].slice(), setOp[1]];
    }
    patches[i] = patch;
  }
  return patches;
}

function collectRowObjectHistoryChange(source: JsonValue, target: JsonValue): RowObjectHistoryChange | null {
  const collector: RowObjectHistoryCollector = {
    arrayPath: null,
    indexes: [],
    fields: [],
    setOps: []
  };
  const path: JsonPath = [];
  if (!collectRowObjectHistoryChangeInto(source, target, path, collector, 0) || collector.arrayPath === null) return null;
  return {
    arrayPath: collector.arrayPath,
    indexes: collector.indexes,
    fields: collector.fields,
    setOps: collector.setOps,
    target
  };
}

function collectRowObjectHistoryChangeInto(
  source: JsonValue,
  target: JsonValue,
  path: JsonPath,
  collector: RowObjectHistoryCollector,
  depth: number
): boolean {
  if (sameHistoryScalarOrRef(source, target)) return true;
  if (Array.isArray(source) || Array.isArray(target)) {
    return collectRowObjectArrayHistoryChange(source, target, path, collector);
  }
  if (!isHistoryPlainObject(source) || !isHistoryPlainObject(target)) {
    collector.setOps[collector.setOps.length] = [path.slice(), target];
    return true;
  }

  const sourceKeys = Object.keys(source);
  const targetKeys = Object.keys(target);
  if (sourceKeys.length !== targetKeys.length || depth > TRAINING_MAX_DEPTH) return false;
  for (let i = 0, length = sourceKeys.length; i < length; i++) {
    const key = sourceKeys[i];
    if (targetKeys[i] !== key || !hasOwn.call(target, key)) return false;
    path[depth] = key;
    if (!collectRowObjectHistoryChangeInto(source[key], target[key], path, collector, depth + 1)) return false;
    path.length = depth;
  }
  return true;
}

function collectRowObjectArrayHistoryChange(
  source: JsonValue,
  target: JsonValue,
  path: JsonPath,
  collector: RowObjectHistoryCollector
): boolean {
  if (!Array.isArray(source) || !Array.isArray(target) || source.length !== target.length || collector.arrayPath !== null) return false;

  const indexes: number[] = [];
  const fields: string[] = [];
  const rowCount = source.length;
  let startRow = 0;
  while (startRow < rowCount && sameHistoryScalarOrRef(source[startRow], target[startRow])) startRow++;
  if (startRow === rowCount) return true;

  let endRow = rowCount - 1;
  while (endRow > startRow && sameHistoryScalarOrRef(source[endRow], target[endRow])) endRow--;

  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex++) {
    const sourceRow = source[rowIndex];
    const targetRow = target[rowIndex];
    if (sameHistoryScalarOrRef(sourceRow, targetRow)) continue;
    if (!isHistoryPlainObject(sourceRow) || !isHistoryPlainObject(targetRow)) return false;
    const sourceKeys = Object.keys(sourceRow);
    const targetKeys = Object.keys(targetRow);
    if (sourceKeys.length !== targetKeys.length) return false;

    let changed = false;
    for (let keyIndex = 0, keyCount = sourceKeys.length; keyIndex < keyCount; keyIndex++) {
      const key = sourceKeys[keyIndex];
      if (targetKeys[keyIndex] !== key || !hasOwn.call(targetRow, key)) return false;
      if (!sameHistoryScalarOrRef(sourceRow[key], targetRow[key])) {
        changed = true;
        addUniqueHistoryField(fields, key);
      }
    }
    if (changed) indexes[indexes.length] = rowIndex;
  }

  if (indexes.length === 0) return true;
  collector.arrayPath = path.slice();
  collector.indexes = indexes;
  for (let i = 0, length = fields.length; i < length; i++) addUniqueHistoryField(collector.fields, fields[i]);
  return true;
}

function addUniqueHistoryField(fields: string[], field: string): void {
  for (let i = 0, length = fields.length; i < length; i++) {
    if (fields[i] === field) return;
  }
  fields[fields.length] = field;
}

function tryObjectAssignDiffHistory(initial: JsonValue, states: JsonValue[]): Patch[] | null {
  if (states.length < 8) return null;

  const groups = collectHistoryAssignGroups(initial, states[0]);
  if (groups === null || groups.length === 0 || groups.length > HISTORY_OBJECT_ASSIGN_GROUP_MAX) return null;
  let hasLargeGroup = false;
  let totalKeys = 0;
  for (let i = 0, groupCount = groups.length; i < groupCount; i++) {
    const keyCount = groups[i].keys.length;
    totalKeys += keyCount;
    if (keyCount >= HISTORY_OBJECT_ASSIGN_FIELD_MIN) hasLargeGroup = true;
  }
  if (!hasLargeGroup || totalKeys > HISTORY_OBJECT_ASSIGN_TOTAL_KEY_MAX) return null;

  const patches = new Array<Patch>(states.length);
  let previous = initial;
  for (let i = 0, length = states.length; i < length; i++) {
    const target = states[i];
    const nextGroups = collectHistoryAssignGroups(previous, target);
    if (nextGroups === null || !sameHistoryAssignGroups(groups, nextGroups)) return null;

    const patch = new Array<PatchOperation>(groups.length);
    for (let groupIndex = 0, groupCount = groups.length; groupIndex < groupCount; groupIndex++) {
      const group = groups[groupIndex];
      const object = readHistoryPath(target, group.path);
      if (!isHistoryPlainObject(object)) return null;
      patch[groupIndex] = [
        OP_ASSIGN,
        group.path.slice(),
        historyAssignGroupCoversObject(group.keys, object) ? object : makeHistoryAssignPayload(group.keys, object)
      ];
    }
    patches[i] = patch;
    previous = target;
  }
  return patches;
}

function historyAssignGroupCoversObject(keys: string[], object: Record<string, JsonValue>): boolean {
  const objectKeys = Object.keys(object);
  if (objectKeys.length !== keys.length) return false;
  for (let i = 0, length = keys.length; i < length; i++) {
    if (objectKeys[i] !== keys[i]) return false;
  }
  return true;
}

function makeHistoryAssignPayload(keys: string[], object: Record<string, JsonValue>): Record<string, JsonValue> {
  const assign: Record<string, JsonValue> = {};
  for (let keyIndex = 0, keyCount = keys.length; keyIndex < keyCount; keyIndex++) {
    const key = keys[keyIndex];
    assign[key] = object[key];
  }
  return assign;
}

function collectHistoryAssignGroups(source: JsonValue, target: JsonValue): HistoryAssignGroup[] | null {
  const groups: HistoryAssignGroup[] = [];
  const path: JsonPath = [];
  return collectHistoryAssignGroupsInto(source, target, path, groups, 0) ? groups : null;
}

function collectHistoryAssignGroupsInto(
  source: JsonValue,
  target: JsonValue,
  path: JsonPath,
  groups: HistoryAssignGroup[],
  depth: number
): boolean {
  if (groups.length > HISTORY_OBJECT_ASSIGN_GROUP_MAX || depth > TRAINING_MAX_DEPTH) return false;
  if (sameHistoryScalarOrRef(source, target)) return true;
  if (!isHistoryPlainObject(source) || !isHistoryPlainObject(target)) return false;

  const sourceKeys = Object.keys(source);
  const targetKeys = Object.keys(target);
  if (sourceKeys.length !== targetKeys.length) return false;

  const changedKeys: string[] = [];
  for (let i = 0, length = sourceKeys.length; i < length; i++) {
    const key = sourceKeys[i];
    if (targetKeys[i] !== key || !hasOwn.call(target, key)) return false;
    const sourceValue = source[key];
    const targetValue = target[key];
    if (sameHistoryScalarOrRef(sourceValue, targetValue)) continue;
    if (isHistoryPlainObject(sourceValue) && isHistoryPlainObject(targetValue)) {
      path[depth] = key;
      if (!collectHistoryAssignGroupsInto(sourceValue, targetValue, path, groups, depth + 1)) return false;
      path.length = depth;
    } else {
      changedKeys[changedKeys.length] = key;
    }
  }

  if (changedKeys.length !== 0) {
    groups[groups.length] = { path: path.slice(), keys: changedKeys };
  }
  return true;
}

function sameHistoryAssignGroups(left: HistoryAssignGroup[], right: HistoryAssignGroup[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0, length = left.length; i < length; i++) {
    const leftGroup = left[i];
    const rightGroup = right[i];
    if (!sameHistoryPath(leftGroup.path, rightGroup.path)) return false;
    const leftKeys = leftGroup.keys;
    const rightKeys = rightGroup.keys;
    if (leftKeys.length !== rightKeys.length) return false;
    for (let j = 0, keyCount = leftKeys.length; j < keyCount; j++) {
      if (leftKeys[j] !== rightKeys[j]) return false;
    }
  }
  return true;
}

function tryScalarObjectDiffHistory(initial: JsonValue, states: JsonValue[]): Patch[] | null {
  const paths = collectScalarHistoryPaths(initial);
  if (paths === null || paths.length === 0 || paths.length > 64) return null;

  for (let i = 0, length = states.length; i < length; i++) {
    if (!hasSameScalarHistoryShapeAsTemplate(states[i], initial)) return null;
  }

  const patches = new Array<Patch>(states.length);
  let previous = initial;
  for (let i = 0, length = states.length; i < length; i++) {
    const target = states[i];
    const patch: Patch = [];
    for (let j = 0, pathCount = paths.length; j < pathCount; j++) {
      const path = paths[j];
      const sourceValue = readHistoryPath(previous, path);
      const targetValue = readHistoryPath(target, path);
      if (sameHistoryScalarOrRef(sourceValue, targetValue)) continue;
      if (
        typeof sourceValue === 'string' &&
        typeof targetValue === 'string' &&
        (sourceValue.length >= 32 || targetValue.length >= 32)
      ) {
        return null;
      }
      patch[patch.length] = [OP_SET, path.slice(), targetValue as JsonValue];
    }
    patches[i] = patch;
    previous = target;
  }
  return patches;
}

function collectScalarHistoryPaths(value: JsonValue): JsonPath[] | null {
  if (!isHistoryPlainObject(value)) return null;
  const paths: JsonPath[] = [];
  return collectScalarHistoryPathsInto(value, [], paths, 0) ? paths : null;
}

function collectScalarHistoryPathsInto(value: JsonValue, path: JsonPath, paths: JsonPath[], depth: number): boolean {
  if (paths.length > 64 || depth > 4) return false;
  if (value === null || typeof value !== 'object') {
    paths[paths.length] = path.slice();
    return true;
  }
  if (!isHistoryPlainObject(value)) return false;
  const keys = Object.keys(value);
  for (let i = 0, length = keys.length; i < length; i++) {
    const key = keys[i];
    path[depth] = key;
    if (!collectScalarHistoryPathsInto(value[key], path, paths, depth + 1)) return false;
    path.length = depth;
  }
  return true;
}

function readHistoryPath(value: JsonValue, path: JsonPath): JsonValue | undefined {
  let cursor: unknown = value;
  for (let i = 0, length = path.length; i < length; i++) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string | number, unknown>)[path[i]];
  }
  return cursor as JsonValue | undefined;
}

function hasSameScalarHistoryShapeAsTemplate(value: JsonValue, template: JsonValue): boolean {
  if (template === null || typeof template !== 'object') {
    return value === null || typeof value !== 'object';
  }
  if (!isHistoryPlainObject(value) || !isHistoryPlainObject(template)) return false;

  const templateKeys = Object.keys(template);
  const valueKeys = Object.keys(value);
  if (valueKeys.length !== templateKeys.length) return false;
  for (let i = 0, length = templateKeys.length; i < length; i++) {
    const key = templateKeys[i];
    if (valueKeys[i] !== key || !hasOwn.call(value, key)) return false;
    if (!hasSameScalarHistoryShapeAsTemplate(value[key], template[key])) return false;
  }
  return true;
}

function isHistoryPlainObject(value: unknown): value is Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sameHistoryPath(left: JsonPath, right: JsonPath): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0, length = left.length; i < length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sameHistoryPathList(left: JsonPath[], right: JsonPath[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0, length = left.length; i < length; i++) {
    if (!sameHistoryPath(left[i], right[i])) return false;
  }
  return true;
}

function sameHistoryScalarOrRef(source: unknown, target: unknown): boolean {
  return source === target && (source !== 0 || 1 / (source as number) === 1 / (target as number));
}

function readOptions(options, label) {
  if (options === undefined || options === null) return undefined;
  if (typeof options !== 'object') {
    throw new TypeError(label + ' must be an object');
  }
  return options;
}

function mergeOptions(baseOptions, options) {
  const callOptions = readOptions(options, 'options');
  if (baseOptions === undefined) return callOptions;
  if (callOptions === undefined) return baseOptions;
  return { ...baseOptions, ...callOptions };
}

function readQuantizationContext(options): QuantizationContext | null {
  if (!options || options.quantization === undefined || options.quantization === null) return null;
  const rules = readQuantizationRules(options.quantization, 'quantization');
  return rules === undefined || rules.length === 0 ? null : { rules };
}

function readQuantizationRules(value, label): NumericQuantizationRule[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(label + ' option must be an array of numeric quantization rules');
  }
  const rules: NumericQuantizationRule[] = [];
  for (let i = 0, length = value.length; i < length; i++) {
    const item = value[i];
    const itemLabel = label + '[' + i + ']';
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(itemLabel + ' must be an object');
    }
    const rule = item as NumericQuantizationRule;
    if (typeof rule.step !== 'number' || !Number.isFinite(rule.step) || rule.step <= 0 || Object.is(rule.step, -0)) {
      throw new TypeError(itemLabel + '.step must be a positive finite number');
    }
    if (
      rule.offset !== undefined &&
      (typeof rule.offset !== 'number' || !Number.isFinite(rule.offset))
    ) {
      throw new TypeError(itemLabel + '.offset must be a finite number');
    }
    if (rule.mode !== undefined && rule.mode !== 'nearest' && rule.mode !== 'floor' && rule.mode !== 'ceil') {
      throw new TypeError(itemLabel + '.mode must be "nearest", "floor", or "ceil"');
    }
    if (rule.fixedStep !== undefined && typeof rule.fixedStep !== 'boolean') {
      throw new TypeError(itemLabel + '.fixedStep must be a boolean');
    }
    const normalized: NumericQuantizationRule = {
      step: rule.step
    };
    if (rule.path !== undefined && rule.path !== null) normalized.path = readQuantizationRulePath(rule.path, itemLabel + '.path');
    if (rule.offset !== undefined) normalized.offset = rule.offset;
    if (rule.mode !== undefined) normalized.mode = rule.mode;
    if (rule.fixedStep !== undefined) normalized.fixedStep = rule.fixedStep;
    rules[rules.length] = normalized;
  }
  return rules;
}

function readQuantizationRulePath(value, label): JsonPath {
  if (!Array.isArray(value)) {
    throw new TypeError(label + ' must be an array of strings or numbers');
  }
  const out: JsonPath = new Array(value.length);
  for (let i = 0, length = value.length; i < length; i++) {
    const segment = value[i];
    if (typeof segment !== 'string' && typeof segment !== 'number') {
      throw new TypeError(label + ' segments must be strings or numbers');
    }
    out[i] = segment;
  }
  return out;
}

function omitProfileOption(options) {
  if (options === undefined || options === null || options.profile === undefined) return options;
  const out = { ...options };
  delete out.profile;
  return out;
}

function readMaxEntries(options) {
  if (!options) return DEFAULT_MAX_ENTRIES;
  const value = options.cacheSize === undefined ? options.maxEntries : options.cacheSize;
  if (value === undefined) return DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('cacheSize option must be a non-negative safe integer');
  }
  return value;
}

function validateAdaptiveOption(options) {
  if (!options || options.adaptive === undefined) return;
  if (typeof options.adaptive !== 'boolean') {
    throw new TypeError('adaptive option must be a boolean');
  }
}

function shouldUseEnginePlan(options) {
  return !options ||
    (
      (options.dirtyPaths === undefined || options.dirtyPaths === null) &&
      (options.dirtyRows === undefined || options.dirtyRows === null)
    );
}

function hasAvailableSchemaPlan(options, baseSchemaPlan, profilePlan) {
  if (!shouldUseEnginePlan(options)) return false;
  if (baseSchemaPlan !== null || profilePlan !== null) return true;
  return options && options.schema !== undefined && options.schema !== null;
}

function readCacheState(source, target, options) {
  if (
    options &&
    (
      (options.dirtyPaths !== undefined && options.dirtyPaths !== null) ||
      (options.dirtyRows !== undefined && options.dirtyRows !== null)
    )
  ) {
    return null;
  }

  const tokenState = readTokenState(options);
  if (tokenState === null) return null;

  const sourceToken = tokenState.read(source);
  const targetToken = tokenState.read(target);
  if (
    sourceToken === undefined ||
    sourceToken === null ||
    targetToken === undefined ||
    targetToken === null
  ) {
    return null;
  }

  return {
    sourceToken,
    targetToken,
    signature: makeOutputSignature(options, tokenState)
  };
}

function readTokenState(options) {
  if (!options) return null;
  if (options.getVersion !== undefined) {
    if (typeof options.getVersion !== 'function') {
      throw new TypeError('getVersion option must be a function');
    }
    return {
      mode: 'getVersion',
      value: options.getVersion,
      read: options.getVersion
    };
  }
  if (options.getFingerprint !== undefined) {
    if (typeof options.getFingerprint !== 'function') {
      throw new TypeError('getFingerprint option must be a function');
    }
    return {
      mode: 'getFingerprint',
      value: options.getFingerprint,
      read: options.getFingerprint
    };
  }
  if (options.versionKey !== undefined) {
    const key = options.versionKey;
    return {
      mode: 'versionKey',
      value: key,
      read: (value) => value !== null && typeof value === 'object'
        ? value[key]
        : undefined
    };
  }
  if (options.fingerprintKey !== undefined) {
    const key = options.fingerprintKey;
    return {
      mode: 'fingerprintKey',
      value: key,
      read: (value) => value !== null && typeof value === 'object'
        ? value[key]
        : undefined
    };
  }
  return null;
}

function makeOutputSignature(options, tokenState) {
  const keyState = readKeyState(options);
  const arrayState = readArrayState(options);
  const planState = readPlanState(options);
  const patchState = readPatchState(options);
  return [
    tokenState.mode,
    tokenState.value,
    keyState.mode,
    keyState.value,
    arrayState.mode,
    arrayState.value,
    planState.mode,
    planState.value,
    patchState.mode,
    patchState.value
  ];
}

function readKeyState(options) {
  if (!options) return { mode: 'none', value: undefined };
  if (typeof options.keyCompare === 'function') {
    return { mode: 'keyCompare', value: options.keyCompare };
  }
  if (typeof options.stable === 'function') {
    return { mode: 'stableCompare', value: options.stable };
  }
  if (options.stable || options.sortKeys) {
    return { mode: 'lexical', value: undefined };
  }
  return { mode: 'none', value: undefined };
}

function readArrayState(options) {
  if (!options) return { mode: 'auto', value: undefined };
  if (options.arrayKey === false || options.autoArrayKey === false) {
    return { mode: 'disabled', value: undefined };
  }
  if (options.getArrayKey !== undefined) {
    if (typeof options.getArrayKey !== 'function') {
      throw new TypeError('getArrayKey option must be a function');
    }
    return { mode: 'getArrayKey', value: options.getArrayKey };
  }
  if (options.arrayKey !== undefined && options.arrayKey !== null && options.arrayKey !== true) {
    if (typeof options.arrayKey === 'function') {
      return { mode: 'arrayKeyFn', value: options.arrayKey };
    }
    if (typeof options.arrayKey === 'string' || typeof options.arrayKey === 'number') {
      return { mode: 'arrayKey', value: options.arrayKey };
    }
    throw new TypeError('arrayKey option must be a string, number, function, true, false, or null');
  }
  if (options.recordKeyCandidates !== undefined) {
    return { mode: 'recordKeyCandidates', value: options.recordKeyCandidates };
  }
  return { mode: 'auto', value: undefined };
}

function readPlanState(options) {
  if (!options) return { mode: 'none', value: undefined };
  if (options.schema !== undefined) return { mode: 'schema', value: options.schema };
  if (options.profile !== undefined) return { mode: 'profile', value: options.profile };
  if (options.adaptive) return { mode: 'adaptive', value: true };
  return { mode: 'none', value: undefined };
}

function readPatchState(options) {
  if (!options || options.maxPatchOperations === undefined || options.maxPatchOperations === null) {
    return { mode: 'none', value: undefined };
  }
  return { mode: 'maxPatchOperations', value: options.maxPatchOperations };
}

function readSchemaPlan(options) {
  if (!options || options.schema === undefined || options.schema === null) return null;
  return compileSchemaPlan(options.schema);
}

function readProfile(profile) {
  if (profile === undefined || profile === null) return null;
  if (typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError('profile option must be an object');
  }
  if (
    profile.version !== undefined &&
    profile.version !== PROFILE_VERSION
  ) {
    throw new TypeError('unsupported profile version: ' + profile.version);
  }

  const settings = profile.settings === undefined
    ? null
    : readOptions(profile.settings, 'profile settings');
  const schemas = readProfileSchemas(profile);
  const plans = readProfilePlans(profile);
  const profileSchemas = schemas === null
    ? null
    : shouldReadProfileSchemasAsExact(plans)
      ? schemas.map(markProfileSchemaExact)
      : schemas;
  return {
    settings,
    plans,
    plan: profileSchemas === null ? null : compileSchemaPlan({ schemas: profileSchemas })
  };
}

function readHistoryPlanStrategy(plans: ProfilePlans | undefined): HistoryPlanStrategy | null {
  if (plans === undefined || plans.history === undefined || plans.history.strategy === undefined) return null;
  return plans.history.strategy;
}

function shouldReadProfileSchemasAsExact(plans: ProfilePlans | undefined): boolean {
  return plans !== undefined && plans.diff !== undefined && plans.diff.strategy === 'adaptive-schema';
}

function markProfileSchemaExact(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  return { ...schema, exact: true };
}

function readProfileSchemas(profile) {
  if (profile.schemas !== undefined) {
    if (!Array.isArray(profile.schemas)) {
      throw new TypeError('profile schemas must be an array');
    }
    return profile.schemas;
  }
  if (profile.schema !== undefined && profile.schema !== null) {
    return [profile.schema];
  }
  return null;
}

function compileSchemaPlan(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError('schema option must be an object');
  }

  if (Array.isArray(schema.schemas)) {
    if (schema.schemas.length === 0) {
      throw new TypeError('schema list must not be empty');
    }
    const plans = new Array(schema.schemas.length);
    for (let i = 0; i < schema.schemas.length; i++) {
      plans[i] = compileSingleSchemaPlan(schema.schemas[i]);
    }
    return plans.length === 1
      ? plans[0]
      : {
          type: 'multi',
          plans,
          trie: buildPlanPathTrie(plans),
          schema: { schemas: plans.map((plan) => plan.schema) }
        };
  }

  return compileSingleSchemaPlan(schema);
}

function compileSingleSchemaPlan(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError('schema option must be an object');
  }

  if (
    schema.type === 'array' &&
    schema.item !== null &&
    typeof schema.item === 'object' &&
    schema.item.type === 'object' &&
    Array.isArray(schema.item.fields)
  ) {
    return createRecordArrayPlan(schema);
  }

  if (
    schema.type === 'object' &&
    Array.isArray(schema.fields)
  ) {
    return createObjectPlan(schema);
  }

  throw new TypeError('schema option currently supports record arrays or { type: "object", fields: [...] }');
}

function createObjectPlan(schema) {
  const fields = schema.fields;
  if (fields.length === 0) {
    throw new TypeError('schema fields must not be empty');
  }

  const fieldSet = Object.create(null);
  const fieldList = [];
  for (let i = 0; i < fields.length; i++) {
    addFieldPlan(fieldList, fieldSet, fields[i], []);
  }

  const path = readSchemaPath(schema.path);
  const flatKeys = readFlatKeys(fieldList);
  const normalized: NormalizedObjectPlanSchema = {
    type: 'object',
    fields: normalizeFieldSchemas(fields)
  };
  if (path.length !== 0) normalized.path = path.slice();
  if (schema.exact === true) normalized.exact = true;

  return {
    type: 'object',
    path,
    fields: fieldList,
    flatKeys,
    fieldCount: fieldList.length,
    exact: schema.exact === true,
    compiled: flatKeys === null
      ? compileNestedObjectDiff(path, fieldList)
      : compileFlatObjectDiff(path, flatKeys),
    equals: flatKeys === null ? compileNestedObjectEquals(fieldList) : compileFlatObjectEquals(flatKeys),
    schema: normalized
  };
}

function createRecordArrayPlan(schema) {
  const fields = schema.item.fields;
  const fieldCount = fields.length;
  if (fieldCount === 0) {
    throw new TypeError('schema item fields must not be empty');
  }

  const fieldSet = Object.create(null);
  const fieldList = [];
  for (let i = 0; i < fieldCount; i++) {
    addFieldPlan(fieldList, fieldSet, fields[i], []);
  }

  const path = readSchemaPath(schema.path);
  const key = readSchemaKey(schema);
  const flatKeys = readFlatKeys(fieldList);
  const normalized: NormalizedRecordArrayPlanSchema = {
    type: 'array',
    item: {
      type: 'object',
      fields: normalizeFieldSchemas(fields)
    }
  };
  if (path.length !== 0) normalized.path = path.slice();
  if (key !== undefined) normalized.key = key;
  if (schema.exact === true) normalized.exact = true;

  return {
    type: 'recordArray',
    path,
    fields: fieldList,
    flatKeys,
    fieldCount: fieldList.length,
    key,
    exact: schema.exact === true,
    compiled: flatKeys === null
      ? compileNestedRecordArrayDiff(path, fieldList, key)
      : compileFlatRecordArrayDiff(path, flatKeys, key),
    equals: flatKeys === null ? compileNestedRecordArrayEquals(fieldList, key) : compileFlatRecordArrayEquals(flatKeys, key),
    schema: normalized
  };
}

function readFlatKeys(fields) {
  const keys = new Array(fields.length);
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].path.length !== 1) return null;
    keys[i] = fields[i].path[0];
  }
  return keys;
}

function addFieldPlan(fieldList, fieldSet, field, prefix) {
  if (typeof field === 'string' || typeof field === 'number') {
    const path = prefix.concat(field);
    const id = path.join('\0');
    if (fieldSet[id] === true) {
      throw new TypeError('schema item fields must be unique');
    }
    fieldSet[id] = true;
    fieldList[fieldList.length] = { path };
    return;
  }

  if (
    field !== null &&
    typeof field === 'object' &&
    !Array.isArray(field) &&
    (typeof field.key === 'string' || typeof field.key === 'number') &&
    field.type === 'object' &&
    Array.isArray(field.fields)
  ) {
    const nextPrefix = prefix.concat(field.key);
    if (field.fields.length === 0) {
      throw new TypeError('schema nested object fields must not be empty');
    }
    for (let i = 0; i < field.fields.length; i++) {
      addFieldPlan(fieldList, fieldSet, field.fields[i], nextPrefix);
    }
    return;
  }

  throw new TypeError('schema item fields must be strings, numbers, or nested object field descriptors');
}

function normalizeFieldSchemas(fields) {
  const out = new Array(fields.length);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (typeof field === 'string' || typeof field === 'number') {
      out[i] = field;
    } else {
      out[i] = {
        key: field.key,
        type: 'object',
        fields: normalizeFieldSchemas(field.fields)
      };
    }
  }
  return out;
}

function readSchemaPath(path) {
  if (path === undefined || path === null) return [];
  if (!Array.isArray(path)) {
    throw new TypeError('schema path must be an array');
  }
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    if (typeof segment !== 'string' && typeof segment !== 'number') {
      throw new TypeError('schema path segments must be strings or numbers');
    }
  }
  return path.slice();
}

function readSchemaKey(schema) {
  const key = schema.key !== undefined ? schema.key : schema.item.key;
  if (key === undefined || key === null) return undefined;
  if (typeof key !== 'string' && typeof key !== 'number') {
    throw new TypeError('schema key must be a string or number');
  }
  return key;
}

function tryPlannedDiff(plan, source, target, patch, options) {
  const quantization = readQuantizationContext(options);
  if (plan.type === 'multi') {
    const startLength = patch.length;
    for (let i = 0, length = plan.plans.length; i < length; i++) {
      if (!tryPlannedDiffOnly(plan.plans[i], source, target, patch, quantization)) {
        patch.length = startLength;
        return false;
      }
    }
    if (!appendOutsidePlanPathsDiff(source, target, plan.trie, [], patch, options)) {
      patch.length = startLength;
      return false;
    }
    return true;
  }
  if (plan.type === 'recordArray') {
    const startLength = patch.length;
    const sourceValue = readPlanPathValue(source, plan.path);
    const targetValue = readPlanPathValue(target, plan.path);
    if (sourceValue === MISSING_PLAN_VALUE || targetValue === MISSING_PLAN_VALUE) return false;
    if (!exactPlanRegionMatches(plan, sourceValue, targetValue)) return false;
    if (!tryRecordArrayDiff(plan, sourceValue, targetValue, patch, quantization)) return false;
    if (
      plan.path.length !== 0 &&
      !appendOutsidePlanPathDiff(source, target, plan.path, 0, [], patch, options)
    ) {
      patch.length = startLength;
      return false;
    }
    return true;
  }
  if (plan.type === 'object') {
    const startLength = patch.length;
    const sourceValue = readPlanPathValue(source, plan.path);
    const targetValue = readPlanPathValue(target, plan.path);
    if (sourceValue === MISSING_PLAN_VALUE || targetValue === MISSING_PLAN_VALUE) return false;
    if (!exactPlanRegionMatches(plan, sourceValue, targetValue)) return false;
    if (!tryObjectDiff(plan, sourceValue, targetValue, patch, quantization)) return false;
    if (
      plan.path.length !== 0 &&
      !appendOutsidePlanPathDiff(source, target, plan.path, 0, [], patch, options)
    ) {
      patch.length = startLength;
      return false;
    }
    return true;
  }
  return false;
}

function tryPlannedDiffOnly(plan, source, target, patch, quantization: QuantizationContext | null) {
  if (plan.type === 'recordArray') {
    const sourceValue = readPlanPathValue(source, plan.path);
    const targetValue = readPlanPathValue(target, plan.path);
    return (
      sourceValue !== MISSING_PLAN_VALUE &&
      targetValue !== MISSING_PLAN_VALUE &&
      exactPlanRegionMatches(plan, sourceValue, targetValue) &&
      tryRecordArrayDiff(plan, sourceValue, targetValue, patch, quantization)
    );
  }

  if (plan.type === 'object') {
    const sourceValue = readPlanPathValue(source, plan.path);
    const targetValue = readPlanPathValue(target, plan.path);
    return (
      sourceValue !== MISSING_PLAN_VALUE &&
      targetValue !== MISSING_PLAN_VALUE &&
      exactPlanRegionMatches(plan, sourceValue, targetValue) &&
      tryObjectDiff(plan, sourceValue, targetValue, patch, quantization)
    );
  }

  if (plan.type === 'multi') {
    return tryPlannedDiff(plan, source, target, patch, undefined);
  }

  return false;
}

function tryPlannedEquals(plan, source, target, options): boolean | null {
  const quantization = readQuantizationContext(options);
  if (quantization === null) {
    const exact = tryPlannedEqualsNoPatch(plan, source, target);
    if (exact === true) return true;
  }

  const patch: Patch = [];
  return tryPlannedDiff(plan, source, target, patch, options) && patch.length === 0 ? true : null;
}

function tryPlannedEqualsNoPatch(plan, source, target): boolean | null {
  if (plan.type === 'multi') {
    for (let i = 0, length = plan.plans.length; i < length; i++) {
      if (tryPlannedRegionEquals(plan.plans[i], source, target) !== true) return null;
    }
    return equalsOutsidePlanPaths(source, target, plan.trie) ? true : null;
  }

  if (tryPlannedRegionEquals(plan, source, target) !== true) return null;
  return plan.path.length === 0 || equalsOutsidePlanPath(source, target, plan.path, 0) ? true : null;
}

function tryPlannedRegionEquals(plan, source, target): boolean | null {
  if (plan.type !== 'recordArray' && plan.type !== 'object') return null;
  const compiledEquals = plan.equals;
  if (compiledEquals === null) return null;
  const sourceValue = readPlanPathValue(source, plan.path);
  const targetValue = readPlanPathValue(target, plan.path);
  if (sourceValue === MISSING_PLAN_VALUE || targetValue === MISSING_PLAN_VALUE) return null;
  if (!exactPlanRegionMatches(plan, sourceValue, targetValue)) return null;
  return compiledEquals(sourceValue, targetValue) ? true : null;
}

function exactPlanRegionMatches(plan, sourceValue, targetValue): boolean {
  if (plan.exact !== true) return true;
  if (plan.type === 'object') {
    const fields = plan.schema && plan.schema.fields;
    return exactObjectMatchesSchema(sourceValue, fields) && exactObjectMatchesSchema(targetValue, fields);
  }
  if (plan.type === 'recordArray') {
    const fields = plan.schema && plan.schema.item && plan.schema.item.fields;
    return exactRecordArrayMatchesSchema(sourceValue, fields) && exactRecordArrayMatchesSchema(targetValue, fields);
  }
  return true;
}

function exactRecordArrayMatchesSchema(value, fields): boolean {
  if (!Array.isArray(value) || !Array.isArray(fields)) return false;
  for (let i = 0, length = value.length; i < length; i++) {
    if (!exactObjectMatchesSchema(value[i], fields)) return false;
  }
  return true;
}

function exactObjectMatchesSchema(value, fields): boolean {
  if (!isPlanRecordRow(value) || !Array.isArray(fields)) return false;
  const keys = Object.keys(value);
  if (keys.length !== fields.length) return false;
  for (let i = 0, length = fields.length; i < length; i++) {
    const field = fields[i];
    if (typeof field === 'string' || typeof field === 'number') {
      if (!hasOwn.call(value, field)) return false;
    } else {
      if (!hasOwn.call(value, field.key) || !exactObjectMatchesSchema(value[field.key], field.fields)) return false;
    }
  }
  return true;
}

function equalsOutsidePlanPath(source, target, planPath, depth): boolean {
  if (depth >= planPath.length) return true;
  if (!isDiffableContainer(source) || !isDiffableContainer(target)) return false;
  if (Array.isArray(source) || Array.isArray(target)) {
    if (!Array.isArray(source) || !Array.isArray(target) || source.length !== target.length) return false;
  }

  const skip = planPath[depth];
  const skipKey = String(skip);
  const sourceKeys = Object.keys(source);
  for (let i = 0, length = sourceKeys.length; i < length; i++) {
    const key = sourceKeys[i];
    if (key === skipKey) continue;
    if (!hasOwn.call(target, key) || !equalsJsonFast(source[key], target[key])) return false;
  }

  const targetKeys = Object.keys(target);
  for (let i = 0, length = targetKeys.length; i < length; i++) {
    const key = targetKeys[i];
    if (key !== skipKey && !hasOwn.call(source, key)) return false;
  }

  if (!hasOwn.call(source, skip) || !hasOwn.call(target, skip)) return false;
  return equalsOutsidePlanPath(source[skip], target[skip], planPath, depth + 1);
}

function equalsOutsidePlanPaths(source, target, trie): boolean {
  if (trie.terminal) return true;
  if (!isDiffableContainer(source) || !isDiffableContainer(target)) return false;
  if (Array.isArray(source) || Array.isArray(target)) {
    if (!Array.isArray(source) || !Array.isArray(target) || source.length !== target.length) return false;
  }

  const children = trie.children;
  const sourceKeys = Object.keys(source);
  for (let i = 0, length = sourceKeys.length; i < length; i++) {
    const key = sourceKeys[i];
    const child = children[key];
    if (child !== undefined) {
      if (!hasOwn.call(target, key) || !equalsOutsidePlanPaths(source[key], target[key], child)) return false;
    } else if (!hasOwn.call(target, key) || !equalsJsonFast(source[key], target[key])) {
      return false;
    }
  }

  const targetKeys = Object.keys(target);
  for (let i = 0, length = targetKeys.length; i < length; i++) {
    const key = targetKeys[i];
    if (!hasOwn.call(source, key)) return false;
  }

  return true;
}

function buildPlanPathTrie(plans) {
  const root = createPlanPathTrieNode();
  for (let i = 0, length = plans.length; i < length; i++) {
    let node = root;
    const path = plans[i].path;
    for (let j = 0, pathLength = path.length; j < pathLength; j++) {
      const key = String(path[j]);
      let child = node.children[key];
      if (child === undefined) {
        child = createPlanPathTrieNode();
        node.children[key] = child;
      }
      node = child;
    }
    node.terminal = true;
  }
  return root;
}

function createPlanPathTrieNode() {
  return {
    terminal: false,
    children: Object.create(null)
  };
}

const MISSING_PLAN_VALUE = Symbol('missingPlanValue');

function readPlanPathValue(root, path) {
  let value = root;
  for (let i = 0, length = path.length; i < length; i++) {
    if (value === null || typeof value !== 'object') return MISSING_PLAN_VALUE;
    const key = path[i];
    if (!hasOwn.call(value, key)) return MISSING_PLAN_VALUE;
    value = value[key];
  }
  return value;
}

function appendOutsidePlanPathDiff(source, target, planPath, depth, prefix, patch, options) {
  if (depth >= planPath.length) return true;
  if (!isDiffableContainer(source) || !isDiffableContainer(target)) return false;

  const skip = planPath[depth];
  const skipKey = String(skip);
  const sourceKeys = Object.keys(source);
  for (let i = 0, length = sourceKeys.length; i < length; i++) {
    const key = sourceKeys[i];
    if (key === skipKey) continue;
    if (hasOwn.call(target, key)) {
      const sourceChild = source[key];
      const targetChild = target[key];
      if (sameJsonValue(sourceChild, targetChild)) continue;
      appendGenericDiffAtPath(sourceChild, targetChild, appendPathSegment(prefix, key), patch, options);
    } else {
      patch[patch.length] = [OP_REMOVE, appendPathSegment(prefix, key)];
    }
  }

  const targetKeys = Object.keys(target);
  for (let i = 0, length = targetKeys.length; i < length; i++) {
    const key = targetKeys[i];
    if (key === skipKey || hasOwn.call(source, key)) continue;
    patch[patch.length] = [OP_SET, appendPathSegment(prefix, key), clonePayload(target[key])];
  }

  if (!hasOwn.call(source, skip) || !hasOwn.call(target, skip)) return false;
  prefix[prefix.length] = skip;
  const ok = appendOutsidePlanPathDiff(source[skip], target[skip], planPath, depth + 1, prefix, patch, options);
  prefix.length--;
  return ok;
}

function appendOutsidePlanPathsDiff(source, target, trie, prefix, patch, options) {
  if (trie.terminal) return true;
  if (!isDiffableContainer(source) || !isDiffableContainer(target)) return false;

  const children = trie.children;
  const sourceKeys = Object.keys(source);
  for (let i = 0, length = sourceKeys.length; i < length; i++) {
    const key = sourceKeys[i];
    const child = children[key];
    if (child !== undefined) {
      if (!hasOwn.call(target, key)) return false;
      prefix[prefix.length] = readOutputPathSegment(source, key);
      const ok = appendOutsidePlanPathsDiff(source[key], target[key], child, prefix, patch, options);
      prefix.length--;
      if (!ok) return false;
      continue;
    }

    if (hasOwn.call(target, key)) {
      const sourceChild = source[key];
      const targetChild = target[key];
      if (sameJsonValue(sourceChild, targetChild)) continue;
      appendGenericDiffAtPath(sourceChild, targetChild, appendPathSegment(prefix, readOutputPathSegment(source, key)), patch, options);
    } else {
      patch[patch.length] = [OP_REMOVE, appendPathSegment(prefix, readOutputPathSegment(source, key))];
    }
  }

  const targetKeys = Object.keys(target);
  for (let i = 0, length = targetKeys.length; i < length; i++) {
    const key = targetKeys[i];
    if (hasOwn.call(source, key)) continue;
    if (children[key] !== undefined) return false;
    patch[patch.length] = [OP_SET, appendPathSegment(prefix, readOutputPathSegment(target, key)), clonePayload(target[key])];
  }

  return true;
}

function readOutputPathSegment(container, key) {
  return Array.isArray(container) && isArrayIndexKey(key) ? Number(key) : key;
}

function isArrayIndexKey(key) {
  return key !== '' && String(Number(key)) === key && Number.isSafeInteger(Number(key)) && Number(key) >= 0;
}

function isDiffableContainer(value) {
  return value !== null && typeof value === 'object';
}

function appendPathSegment(prefix, key) {
  const out = prefix.slice();
  out[out.length] = key;
  return out;
}

function appendGenericDiffAtPath(source, target, prefix, patch, options) {
  const local = computeDiffInto(source, target, [], options);
  for (let i = 0, length = local.length; i < length; i++) {
    const op = cloneOperation(local[i]);
    op[1] = prefix.concat(op[1]);
    patch[patch.length] = op;
  }
}

function tryRecordArrayDiff(plan, source, target, patch, quantization: QuantizationContext | null) {
  if (quantization === null && plan.compiled !== null) {
    const startLength = patch.length;
    if (plan.compiled(source, target, patch)) return true;
    patch.length = startLength;
    return plan.key !== undefined && tryKeyedRecordArrayPlanDiff(plan, source, target, patch, quantization);
  }

  if (plan.flatKeys !== null) {
    const startLength = patch.length;
    if (tryFlatRecordArrayDiff(plan, source, target, patch, quantization)) return true;
    patch.length = startLength;
    return plan.key !== undefined && tryKeyedRecordArrayPlanDiff(plan, source, target, patch, quantization);
  }

  if (!Array.isArray(source) || !Array.isArray(target)) return false;
  const length = source.length;
  if (length !== target.length) return false;

  const startLength = patch.length;
  const fields = plan.fields;
  const fieldCount = plan.fieldCount;

  for (let i = 0; i < length; i++) {
    const sourceRow = source[i];
    const targetRow = target[i];

    if (
      sourceRow === null ||
      targetRow === null ||
      typeof sourceRow !== 'object' ||
      typeof targetRow !== 'object' ||
      Array.isArray(sourceRow) ||
      Array.isArray(targetRow)
    ) {
      patch.length = startLength;
      return false;
    }

    if (plan.key !== undefined) {
      if (
        !hasOwn.call(sourceRow, plan.key) ||
        !hasOwn.call(targetRow, plan.key) ||
        !sameJsonValue(sourceRow[plan.key], targetRow[plan.key])
      ) {
        patch.length = startLength;
        return false;
      }
    }

    let assign = null;
    let changeCount = 0;
    let changeKey;
    let changeValue;

    for (let j = 0; j < fieldCount; j++) {
      const field = fields[j];
      if (plan.key !== undefined && field.path.length === 1 && field.path[0] === plan.key) continue;
      const sourceValue = field.path.length === 1
        ? readOwnValue(sourceRow, field.path[0])
        : readPlanPathValue(sourceRow, field.path);
      const targetValue = field.path.length === 1
        ? readOwnValue(targetRow, field.path[0])
        : readPlanPathValue(targetRow, field.path);
      if (sourceValue === MISSING_PLAN_VALUE || targetValue === MISSING_PLAN_VALUE) {
        patch.length = startLength;
        return false;
      }
      const comparison = quantization === null
        ? null
        : comparePlannedFieldValues(sourceValue, targetValue, quantization, makePlannedRecordFieldPath(plan, field.path));
      if (comparison === null ? sameJsonValue(sourceValue, targetValue) : comparison.same) continue;
      const plannedTargetValue = comparison === null ? targetValue : comparison.targetValue;

      if (field.path.length === 1) {
        const key = field.path[0];
        changeCount++;
        if (changeCount === 1) {
          changeKey = key;
          changeValue = plannedTargetValue;
        } else {
          if (assign === null) {
            assign = {};
            assign[changeKey] = clonePayload(changeValue);
          }
          assign[key] = clonePayload(plannedTargetValue);
        }
      } else {
        patch[patch.length] = [OP_SET, makeRecordPath(plan.path, i, field.path), clonePayload(plannedTargetValue)];
      }
    }

    if (changeCount === 1) {
      patch[patch.length] = [OP_SET, makeRecordPath(plan.path, i, changeKey), clonePayload(changeValue)];
    } else if (changeCount > 1) {
      patch[patch.length] = [OP_ASSIGN, makeRecordPath(plan.path, i), assign];
    }
  }

  return true;
}

function tryKeyedRecordArrayPlanDiff(plan, source, target, patch, quantization: QuantizationContext | null) {
  if (plan.key === undefined || !Array.isArray(source) || !Array.isArray(target)) return false;

  const startLength = patch.length;
  const sourceLength = source.length;
  const targetLength = target.length;
  const arrayPath = plan.path.slice();

  if (sourceLength === 0) {
    if (targetLength !== 0) {
      patch[patch.length] = [OP_APPEND, arrayPath, clonePayload(target)];
    }
    return true;
  }

  if (targetLength === 0) {
    patch[patch.length] = [OP_TRUNCATE, arrayPath, 0];
    return true;
  }

  const sourceKeys = new Array(sourceLength);
  const sourceKeyToIndex = new Map();
  for (let i = 0; i < sourceLength; i++) {
    const row = source[i];
    if (!isPlanRecordRow(row) || !hasOwn.call(row, plan.key)) return false;
    const key = row[plan.key];
    if (!isPlannedRecordKeyValue(key) || sourceKeyToIndex.has(key)) return false;
    sourceKeys[i] = key;
    sourceKeyToIndex.set(key, i);
  }

  const targetKeys = new Array(targetLength);
  const targetSeen = new Set();
  for (let i = 0; i < targetLength; i++) {
    const row = target[i];
    if (!isPlanRecordRow(row) || !hasOwn.call(row, plan.key)) return false;
    const key = row[plan.key];
    if (!isPlannedRecordKeyValue(key) || targetSeen.has(key)) return false;
    targetKeys[i] = key;
    targetSeen.add(key);
  }

  const workKeys = sourceKeys.slice();
  for (let sourceIndex = sourceLength - 1; sourceIndex >= 0;) {
    if (targetSeen.has(workKeys[sourceIndex])) {
      sourceIndex--;
      continue;
    }

    const deleteEnd = sourceIndex + 1;
    do {
      sourceIndex--;
    } while (sourceIndex >= 0 && !targetSeen.has(workKeys[sourceIndex]));

    const deleteStart = sourceIndex + 1;
    const deleteCount = deleteEnd - deleteStart;
    patch[patch.length] = [OP_ARRAY_SPLICE, arrayPath, deleteStart, deleteCount, []];
    workKeys.splice(deleteStart, deleteCount);
  }

  for (let targetIndex = 0; targetIndex < targetLength; targetIndex++) {
    const targetKey = targetKeys[targetIndex];
    if (workKeys[targetIndex] === targetKey) continue;
    if (!sourceKeyToIndex.has(targetKey)) {
      let insertEnd = targetIndex + 1;
      while (insertEnd < targetLength && !sourceKeyToIndex.has(targetKeys[insertEnd])) insertEnd++;

      const insertCount = insertEnd - targetIndex;
      const values = new Array(insertCount);
      const keys = new Array(insertCount);
      for (let i = 0; i < insertCount; i++) {
        values[i] = clonePayload(target[targetIndex + i]);
        keys[i] = targetKeys[targetIndex + i];
      }
      patch[patch.length] = [OP_ARRAY_SPLICE, arrayPath, targetIndex, 0, values];
      insertPlannedKeys(workKeys, targetIndex, keys);
      targetIndex = insertEnd - 1;
      continue;
    }

    const sourceIndex = indexOfPlannedKey(workKeys, targetKey, targetIndex + 1);
    if (sourceIndex < 0) {
      patch.length = startLength;
      return false;
    }
    patch[patch.length] = [OP_ARRAY_MOVE, arrayPath, sourceIndex, targetIndex];
    movePlannedKey(workKeys, sourceIndex, targetIndex);
  }

  const batch = { indexes: null, values: null };
  for (let targetIndex = 0; targetIndex < targetLength; targetIndex++) {
    const sourceIndex = sourceKeyToIndex.get(targetKeys[targetIndex]);
    if (sourceIndex === undefined) continue;
    if (
      !appendKeyedRecordArrayPlanRowDiff(plan, source[sourceIndex], target[targetIndex], targetIndex, patch, batch, quantization)
    ) {
      patch.length = startLength;
      return false;
    }
  }
  flushKeyedRecordArrayPlanBatch(plan, patch, batch);

  return true;
}

function appendKeyedRecordArrayPlanRowDiff(plan, sourceRow, targetRow, targetIndex, patch, batch, quantization: QuantizationContext | null) {
  if (!isPlanRecordRow(sourceRow) || !isPlanRecordRow(targetRow)) return false;

  const fields = plan.fields;
  const fieldCount = plan.fieldCount;
  let assign = null;
  let changeCount = 0;
  let changeKey;
  let changeValue;

  for (let i = 0; i < fieldCount; i++) {
    const field = fields[i];
    if (field.path.length === 1 && field.path[0] === plan.key) continue;

    const sourceValue = field.path.length === 1
      ? readOwnValue(sourceRow, field.path[0])
      : readPlanPathValue(sourceRow, field.path);
    const targetValue = field.path.length === 1
      ? readOwnValue(targetRow, field.path[0])
      : readPlanPathValue(targetRow, field.path);
    if (sourceValue === MISSING_PLAN_VALUE || targetValue === MISSING_PLAN_VALUE) return false;
    const comparison = quantization === null
      ? null
      : comparePlannedFieldValues(sourceValue, targetValue, quantization, makePlannedRecordFieldPath(plan, field.path));
    if (comparison === null ? sameJsonValue(sourceValue, targetValue) : comparison.same) continue;
    const plannedTargetValue = comparison === null ? targetValue : comparison.targetValue;

    if (field.path.length === 1) {
      const key = field.path[0];
      changeCount++;
      if (changeCount === 1) {
        changeKey = key;
        changeValue = plannedTargetValue;
      } else {
        if (assign === null) {
          assign = {};
          assign[changeKey] = clonePayload(changeValue);
        }
        assign[key] = clonePayload(plannedTargetValue);
      }
    } else {
      flushKeyedRecordArrayPlanBatch(plan, patch, batch);
      patch[patch.length] = [OP_SET, makeRecordPath(plan.path, targetIndex, field.path), clonePayload(plannedTargetValue)];
    }
  }

  if (changeCount === 1) {
    appendKeyedRecordArrayPlanBatchValue(batch, targetIndex, { [changeKey]: clonePayload(changeValue) });
  } else if (changeCount > 1) {
    appendKeyedRecordArrayPlanBatchValue(batch, targetIndex, assign);
  }

  return true;
}

function appendKeyedRecordArrayPlanBatchValue(batch, index, assign) {
  if (batch.indexes === null) {
    batch.indexes = [];
    batch.values = [];
  }
  batch.indexes[batch.indexes.length] = index;
  batch.values[batch.values.length] = assign;
}

function flushKeyedRecordArrayPlanBatch(plan, patch, batch) {
  if (batch.indexes === null) return;
  const indexes = batch.indexes;
  const values = batch.values;
  if (indexes.length === 1) {
    const assign = values[0];
    const keys = Object.keys(assign);
    if (keys.length === 1) {
      const key = keys[0];
      patch[patch.length] = [OP_SET, makeRecordPath(plan.path, indexes[0], key), assign[key]];
    } else {
      patch[patch.length] = [OP_ASSIGN, makeRecordPath(plan.path, indexes[0]), assign];
    }
  } else if (!tryEmitObjectAssignAsFieldAssign(patch, plan.path.slice(), indexes, values)) {
    patch[patch.length] = [OP_ARRAY_OBJECT_ASSIGN, plan.path.slice(), indexes, values];
  }
  batch.indexes = null;
  batch.values = null;
}

function isPlanRecordRow(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlannedRecordKeyValue(value) {
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return Number.isSafeInteger(value) && !Object.is(value, -0);
  return typeof value === 'boolean';
}

function indexOfPlannedKey(keys, key, start) {
  for (let i = start, length = keys.length; i < length; i++) {
    if (keys[i] === key) return i;
  }
  return -1;
}

function insertPlannedKeys(keys, index, values) {
  for (let i = keys.length - 1; i >= index; i--) keys[i + values.length] = keys[i];
  for (let i = 0, length = values.length; i < length; i++) keys[index + i] = values[i];
}

function movePlannedKey(keys, from, to) {
  const value = keys[from];
  if (from < to) {
    for (let i = from; i < to; i++) keys[i] = keys[i + 1];
  } else {
    for (let i = from; i > to; i--) keys[i] = keys[i - 1];
  }
  keys[to] = value;
}

function tryObjectDiff(plan, source, target, patch, quantization: QuantizationContext | null) {
  if (quantization === null && plan.compiled !== null) {
    return plan.compiled(source, target, patch);
  }

  if (
    source === null ||
    target === null ||
    typeof source !== 'object' ||
    typeof target !== 'object' ||
    Array.isArray(source) ||
    Array.isArray(target)
  ) {
    return false;
  }

  const startLength = patch.length;
  const fields = plan.fields;
  const fieldCount = plan.fieldCount;
  let assign = null;
  let changeCount = 0;
  let changeKey;
  let changeValue;

  for (let i = 0; i < fieldCount; i++) {
    const field = fields[i];
    const sourceValue = field.path.length === 1
      ? readOwnValue(source, field.path[0])
      : readPlanPathValue(source, field.path);
    const targetValue = field.path.length === 1
      ? readOwnValue(target, field.path[0])
      : readPlanPathValue(target, field.path);
    if (sourceValue === MISSING_PLAN_VALUE || targetValue === MISSING_PLAN_VALUE) {
      patch.length = startLength;
      return false;
    }
    const comparison = quantization === null
      ? null
      : comparePlannedFieldValues(sourceValue, targetValue, quantization, makePlannedObjectFieldPath(plan, field.path));
    if (comparison === null ? sameJsonValue(sourceValue, targetValue) : comparison.same) continue;
    const plannedTargetValue = comparison === null ? targetValue : comparison.targetValue;

    if (field.path.length === 1) {
      if (!canAssignPlannedValue(sourceValue, plannedTargetValue)) {
        patch.length = startLength;
        return false;
      }

      const key = field.path[0];
      changeCount++;
      if (changeCount === 1) {
        changeKey = key;
        changeValue = plannedTargetValue;
      } else {
        if (assign === null) {
          assign = {};
          assign[changeKey] = clonePayload(changeValue);
        }
        assign[key] = clonePayload(plannedTargetValue);
      }
    } else {
      patch[patch.length] = [OP_SET, makeObjectPath(plan.path, field.path), clonePayload(plannedTargetValue)];
    }
  }

  if (changeCount === 1) {
    patch[patch.length] = [OP_SET, makeObjectPath(plan.path, changeKey), clonePayload(changeValue)];
  } else if (changeCount > 1) {
    patch[patch.length] = [OP_ASSIGN, plan.path.slice(), assign];
  }

  return true;
}

function tryFlatRecordArrayDiff(plan, source, target, patch, quantization: QuantizationContext | null) {
  if (quantization === null && plan.compiled !== null) {
    return plan.compiled(source, target, patch);
  }

  if (!Array.isArray(source) || !Array.isArray(target)) return false;
  const length = source.length;
  if (length !== target.length) return false;

  const startLength = patch.length;
  const fields = plan.flatKeys;
  const fieldCount = plan.fieldCount;

  for (let i = 0; i < length; i++) {
    const sourceRow = source[i];
    const targetRow = target[i];

    if (
      sourceRow === null ||
      targetRow === null ||
      typeof sourceRow !== 'object' ||
      typeof targetRow !== 'object' ||
      Array.isArray(sourceRow) ||
      Array.isArray(targetRow)
    ) {
      patch.length = startLength;
      return false;
    }

    if (plan.key !== undefined) {
      if (
        !hasOwn.call(sourceRow, plan.key) ||
        !hasOwn.call(targetRow, plan.key) ||
        !sameJsonValue(sourceRow[plan.key], targetRow[plan.key])
      ) {
        patch.length = startLength;
        return false;
      }
    }

    let assign = null;
    let changeCount = 0;
    let changeKey;
    let changeValue;

    for (let j = 0; j < fieldCount; j++) {
      const key = fields[j];
      if (plan.key !== undefined && key === plan.key) continue;
      const sourceValue = sourceRow[key];
      const targetValue = targetRow[key];
      if (
        (sourceValue === undefined && !hasOwn.call(sourceRow, key)) ||
        (targetValue === undefined && !hasOwn.call(targetRow, key))
      ) {
        patch.length = startLength;
        return false;
      }
      const comparison = quantization === null
        ? null
        : comparePlannedFieldValues(sourceValue, targetValue, quantization, makePlannedRecordFieldPath(plan, [key]));
      if (comparison === null ? sameJsonValue(sourceValue, targetValue) : comparison.same) continue;
      const plannedTargetValue = comparison === null ? targetValue : comparison.targetValue;

      changeCount++;
      if (changeCount === 1) {
        changeKey = key;
        changeValue = plannedTargetValue;
      } else {
        if (assign === null) {
          assign = {};
          assign[changeKey] = clonePayload(changeValue);
        }
        assign[key] = clonePayload(plannedTargetValue);
      }
    }

    if (changeCount === 1) {
      patch[patch.length] = [OP_SET, makeRecordPath(plan.path, i, changeKey), clonePayload(changeValue)];
    } else if (changeCount > 1) {
      patch[patch.length] = [OP_ASSIGN, makeRecordPath(plan.path, i), assign];
    }
  }

  return true;
}

function compileFlatRecordArrayDiff(path, fields, key) {
  const bitmaskCompiled = compileFlatRecordArrayBitmaskDiff(path, fields, key);
  if (bitmaskCompiled !== null) return bitmaskCompiled;

  const cacheKey = makeCompiledPlanCacheKey('recordArray', path, fields, key);
  const cached = flatRecordArrayDiffCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const pathPrefix = path.map((segment) => JSON.stringify(segment)).join(',');
  const prefix = pathPrefix === '' ? '' : pathPrefix + ',';
  const rowPath = '[' + prefix + 'i]';
  const startPath = pathPrefix === '' ? '[]' : '[' + pathPrefix + ']';
  const singleRowPath = '[' + prefix + 'batchIndexes[0]]';
  const singleKeyPath = '[' + prefix + 'batchIndexes[0],singleKey]';
  const lines = [
    'return function compiledFlatRecordArrayDiff(source,target,patch){',
    'if(!Array.isArray(source)||!Array.isArray(target))return false;',
    'const length=source.length;',
    'if(length!==target.length)return false;',
    'const startLength=patch.length;',
    'let batchIndexes=null;',
    'let batchValues=null;',
    'for(let i=0;i<length;i++){',
    'const sr=source[i];',
    'const tr=target[i];',
    'if(i<16&&(sr===null||tr===null||typeof sr!=="object"||typeof tr!=="object"||Array.isArray(sr)||Array.isArray(tr))){patch.length=startLength;return false;}'
  ];

  if (key !== undefined) {
    const keyLiteral = JSON.stringify(key);
    lines.push(
      'const sk=sr[' + keyLiteral + '];',
      'const tk=tr[' + keyLiteral + '];',
      'if((sk!==tk)||(sk===0&&1/sk!==1/tk)){patch.length=startLength;return false;}'
    );
  }

  lines.push(
    'let assign=null;',
    'let changeCount=0;',
    'let changeKey;',
    'let changeValue;'
  );

  for (let i = 0; i < fields.length; i++) {
    if (key !== undefined && fields[i] === key) continue;
    const literal = JSON.stringify(fields[i]);
    const sourceName = 's' + i;
    const targetName = 't' + i;
    lines.push(
      'const ' + sourceName + '=sr[' + literal + '];',
      'const ' + targetName + '=tr[' + literal + '];'
    );
    lines.push(
      'if((' + sourceName + '!==' + targetName + ')||(' + sourceName + '===0&&1/' + sourceName + '!==1/' + targetName + ')){',
      'changeCount++;',
      'if(changeCount===1){changeKey=' + literal + ';changeValue=' + targetName + ';}else{',
      'if(assign===null){assign={};assign[changeKey]=clonePayload(changeValue);}',
      'assign[' + literal + ']=clonePayload(' + targetName + ');',
      '}',
      '}'
    );
  }

  lines.push(
    'if(changeCount===1){if(batchIndexes===null){batchIndexes=[];batchValues=[];}const singleAssign={};singleAssign[changeKey]=clonePayload(changeValue);batchIndexes[batchIndexes.length]=i;batchValues[batchValues.length]=singleAssign;}',
    'else if(changeCount>1){if(batchIndexes===null){batchIndexes=[];batchValues=[];}batchIndexes[batchIndexes.length]=i;batchValues[batchValues.length]=assign;}',
    '}',
    'if(batchIndexes!==null){if(batchIndexes.length===1){const singleAssign=batchValues[0];const singleKeys=Object.keys(singleAssign);if(singleKeys.length===1){const singleKey=singleKeys[0];patch[patch.length]=[OP_SET,' + singleKeyPath + ',singleAssign[singleKey]];}else{patch[patch.length]=[OP_ASSIGN,' + singleRowPath + ',singleAssign];}}else if(!tryEmitObjectAssignAsFieldAssign(patch,' + startPath + ',batchIndexes,batchValues)){patch[patch.length]=[OP_ARRAY_OBJECT_ASSIGN,' + startPath + ',batchIndexes,batchValues];}}',
    'return true;',
    '}'
  );

  try {
    const compiled = Function(
      'OP_SET',
      'OP_ASSIGN',
      'OP_ARRAY_OBJECT_ASSIGN',
      'clonePayload',
      'tryEmitObjectAssignAsFieldAssign',
      lines.join('\n')
    )(OP_SET, OP_ASSIGN, OP_ARRAY_OBJECT_ASSIGN, clonePayload, tryEmitObjectAssignAsFieldAssign);
    rememberCompiledPlan(flatRecordArrayDiffCache, cacheKey, compiled);
    return compiled;
  } catch {
    return null;
  }
}

function compileFlatRecordArrayEquals(fields, key) {
  const cacheKey = makeCompiledPlanCacheKey('recordArrayEquals', [], fields, key);
  const cached = flatRecordArrayEqualsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const lines = [
    'return function compiledFlatRecordArrayEquals(source,target){',
    'if(!Array.isArray(source)||!Array.isArray(target))return false;',
    'const length=source.length;',
    'if(length!==target.length)return false;',
    'for(let i=0;i<length;i++){',
    'const sr=source[i];',
    'const tr=target[i];',
    'if(i<16&&(sr===null||tr===null||typeof sr!=="object"||typeof tr!=="object"||Array.isArray(sr)||Array.isArray(tr)))return false;'
  ];

  if (key !== undefined) {
    const keyLiteral = JSON.stringify(key);
    lines.push(
      'const sk=sr[' + keyLiteral + '];',
      'const tk=tr[' + keyLiteral + '];',
      'if((sk!==tk)||(sk===0&&1/sk!==1/tk))return false;'
    );
  }

  for (let i = 0; i < fields.length; i++) {
    if (key !== undefined && fields[i] === key) continue;
    const literal = JSON.stringify(fields[i]);
    const sourceName = 's' + i;
    const targetName = 't' + i;
    lines.push(
      'const ' + sourceName + '=sr[' + literal + '];',
      'const ' + targetName + '=tr[' + literal + '];',
      'if((' + sourceName + '!==' + targetName + ')||(' + sourceName + '===0&&1/' + sourceName + '!==1/' + targetName + '))return false;'
    );
  }

  lines.push(
    '}',
    'return true;',
    '}'
  );

  try {
    const compiled = Function(lines.join('\n'))();
    rememberCompiledPlan(flatRecordArrayEqualsCache, cacheKey, compiled);
    return compiled;
  } catch {
    return null;
  }
}

function compileNestedRecordArrayEquals(fields, key) {
  const cacheKey = makeCompiledPlanCacheKey('recordArrayNestedEquals', [], fields.map((field) => field.path), key);
  const cached = nestedRecordArrayEqualsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const lines = [
    'return function compiledNestedRecordArrayEquals(source,target){',
    'if(!Array.isArray(source)||!Array.isArray(target))return false;',
    'const length=source.length;',
    'if(length!==target.length)return false;',
    'for(let i=0;i<length;i++){',
    'const sr=source[i];',
    'const tr=target[i];',
    'if(sr===null||tr===null||typeof sr!=="object"||typeof tr!=="object"||Array.isArray(sr)||Array.isArray(tr))return false;'
  ];

  if (key !== undefined) {
    const keyLiteral = JSON.stringify(key);
    lines.push(
      'const sk=sr[' + keyLiteral + '];',
      'const tk=tr[' + keyLiteral + '];',
      'if((sk!==tk)||(sk===0&&1/sk!==1/tk))return false;'
    );
  }

  const parentPrefixes = readNestedParentPrefixes(fields);
  const sourceParents = new Map();
  const targetParents = new Map();
  for (let i = 0; i < parentPrefixes.length; i++) {
    const parentPath = parentPrefixes[i];
    const sourceParent = 'sp' + i;
    const targetParent = 'tp' + i;
    sourceParents.set(pathKey(parentPath), sourceParent);
    targetParents.set(pathKey(parentPath), targetParent);
    appendNestedParentEqualsRead(lines, 'sr', parentPath, sourceParent);
    appendNestedParentEqualsRead(lines, 'tr', parentPath, targetParent);
  }

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (key !== undefined && field.path.length === 1 && field.path[0] === key) continue;
    const sourceName = 's' + i;
    const targetName = 't' + i;
    appendPlannedValueRead(lines, 'sr', field.path, sourceName, sourceParents);
    appendPlannedValueRead(lines, 'tr', field.path, targetName, targetParents);
    appendPlannedEqualsCompare(lines, sourceName, targetName);
  }

  lines.push(
    '}',
    'return true;',
    '}'
  );

  try {
    const compiled = Function('equalsJsonFast', lines.join('\n'))(equalsJsonFast);
    rememberCompiledPlan(nestedRecordArrayEqualsCache, cacheKey, compiled);
    return compiled;
  } catch {
    return null;
  }
}

function compileFlatRecordArrayBitmaskDiff(path, fields, key) {
  const activeFields = [];
  for (let i = 0; i < fields.length; i++) {
    if (key !== undefined && fields[i] === key) continue;
    activeFields[activeFields.length] = fields[i];
  }

  if (activeFields.length < 2 || activeFields.length > BITMASK_RECORD_FIELD_MAX) {
    return null;
  }

  const cacheKey = makeCompiledPlanCacheKey('recordArrayBitmask', path, fields, key);
  const cached = flatRecordArrayBitmaskDiffCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const pathPrefix = path.map((segment) => JSON.stringify(segment)).join(',');
  const prefix = pathPrefix === '' ? '' : pathPrefix + ',';
  const startPath = pathPrefix === '' ? '[]' : '[' + pathPrefix + ']';
  const singleRowPath = '[' + prefix + 'batchIndexes[0]]';
  const singleKeyPath = '[' + prefix + 'batchIndexes[0],singleKey]';
  const lines = [
    'return function compiledFlatRecordArrayBitmaskDiff(source,target,patch){',
    'if(!Array.isArray(source)||!Array.isArray(target))return false;',
    'const length=source.length;',
    'if(length!==target.length)return false;',
    'const startLength=patch.length;',
    'let batchIndexes=null;',
    'let batchMasks=null;',
    'let commonMask=0;',
    'let sameMask=true;',
    'for(let i=0;i<length;i++){',
    'const sr=source[i];',
    'const tr=target[i];',
    'if(i<16&&(sr===null||tr===null||typeof sr!=="object"||typeof tr!=="object"||Array.isArray(sr)||Array.isArray(tr))){patch.length=startLength;return false;}'
  ];

  if (key !== undefined) {
    const keyLiteral = JSON.stringify(key);
    lines.push(
      'const sk=sr[' + keyLiteral + '];',
      'const tk=tr[' + keyLiteral + '];',
      'if((sk!==tk)||(sk===0&&1/sk!==1/tk)){patch.length=startLength;return false;}'
    );
  }

  lines.push('let mask=0;');

  for (let i = 0; i < activeFields.length; i++) {
    const literal = JSON.stringify(activeFields[i]);
    const sourceName = 's' + i;
    const targetName = 't' + i;
    lines.push(
      'const ' + sourceName + '=sr[' + literal + '];',
      'const ' + targetName + '=tr[' + literal + '];',
      'if((' + sourceName + '!==' + targetName + ')||(' + sourceName + '===0&&1/' + sourceName + '!==1/' + targetName + '))mask|=' + (1 << i) + ';'
    );
  }

  lines.push(
    'if(mask!==0){',
    'if(batchIndexes===null){batchIndexes=[];batchMasks=[];commonMask=mask;}else if(mask!==commonMask){sameMask=false;}',
    'batchIndexes[batchIndexes.length]=i;',
    'batchMasks[batchMasks.length]=mask;',
    '}',
    '}',
    'if(batchIndexes!==null){',
    'if(batchIndexes.length===1){const singleAssign=makeBitmaskAssign(target[batchIndexes[0]],activeFields,batchMasks[0]);const singleKeys=Object.keys(singleAssign);if(singleKeys.length===1){const singleKey=singleKeys[0];patch[patch.length]=[OP_SET,' + singleKeyPath + ',singleAssign[singleKey]];}else{patch[patch.length]=[OP_ASSIGN,' + singleRowPath + ',singleAssign];}}',
    'else if(sameMask){const fieldPaths=makeBitmaskFieldPaths(activeFields,commonMask);const fieldValues=[];appendBitmaskFieldValues(target,batchIndexes,activeFields,commonMask,fieldValues);patch[patch.length]=[OP_ARRAY_OBJECT_FIELD_ASSIGN,' + startPath + ',batchIndexes,fieldPaths,fieldValues];}',
    'else{const batchValues=[];for(let bi=0;bi<batchIndexes.length;bi++){batchValues[bi]=makeBitmaskAssign(target[batchIndexes[bi]],activeFields,batchMasks[bi]);}patch[patch.length]=[OP_ARRAY_OBJECT_ASSIGN,' + startPath + ',batchIndexes,batchValues];}',
    '}',
    'return true;',
    '}'
  );

  try {
    const compiled = Function(
      'OP_SET',
      'OP_ASSIGN',
      'OP_ARRAY_OBJECT_ASSIGN',
      'OP_ARRAY_OBJECT_FIELD_ASSIGN',
      'clonePayload',
      'activeFields',
      'makeBitmaskAssign',
      'makeBitmaskFieldPaths',
      'appendBitmaskFieldValues',
      lines.join('\n')
    )(
      OP_SET,
      OP_ASSIGN,
      OP_ARRAY_OBJECT_ASSIGN,
      OP_ARRAY_OBJECT_FIELD_ASSIGN,
      clonePayload,
      activeFields,
      makeBitmaskAssign,
      makeBitmaskFieldPaths,
      appendBitmaskFieldValues
    );
    rememberCompiledPlan(flatRecordArrayBitmaskDiffCache, cacheKey, compiled);
    return compiled;
  } catch {
    return null;
  }
}

function makeBitmaskAssign(row, fields, mask) {
  const assign = {};
  for (let i = 0, length = fields.length; i < length; i++) {
    if ((mask & (1 << i)) !== 0) assign[fields[i]] = clonePayload(row[fields[i]]);
  }
  return assign;
}

function makeBitmaskFieldPaths(fields, mask) {
  const fieldPaths = [];
  for (let i = 0, length = fields.length; i < length; i++) {
    if ((mask & (1 << i)) !== 0) fieldPaths[fieldPaths.length] = [fields[i]];
  }
  return fieldPaths;
}

function appendBitmaskFieldValues(rows, indexes, fields, mask, values) {
  for (let rowOffset = 0, rowCount = indexes.length; rowOffset < rowCount; rowOffset++) {
    const row = rows[indexes[rowOffset]];
    for (let i = 0, fieldCount = fields.length; i < fieldCount; i++) {
      if ((mask & (1 << i)) !== 0) values[values.length] = clonePayload(row[fields[i]]);
    }
  }
}

function tryEmitObjectAssignAsFieldAssign(patch, path, indexes, assigns) {
  if (indexes.length < 4 || assigns.length !== indexes.length) return false;
  const keys = Object.keys(assigns[0]);
  const fieldCount = keys.length;
  if (fieldCount === 0 || fieldCount > 16) return false;

  const values = [];
  for (let rowOffset = 0, rowCount = assigns.length; rowOffset < rowCount; rowOffset++) {
    const assign = assigns[rowOffset];
    if (assign === null || typeof assign !== 'object' || Array.isArray(assign)) return false;
    for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex++) {
      const key = keys[fieldIndex];
      if (!hasOwn.call(assign, key)) return false;
      values[values.length] = clonePayload(assign[key]);
    }
    for (const key in assign) {
      if (!hasOwn.call(assign, key)) continue;
      let matched = false;
      for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex++) {
        if (keys[fieldIndex] === key) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
  }

  const fields = new Array(fieldCount);
  for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex++) {
    fields[fieldIndex] = [keys[fieldIndex]];
  }
  patch[patch.length] = [OP_ARRAY_OBJECT_FIELD_ASSIGN, path, indexes, fields, values];
  return true;
}

function compileNestedRecordArrayDiff(path, fields, key) {
  const cacheKey = makeCompiledPlanCacheKey('recordArrayNested', path, fields.map((field) => field.path), key);
  const cached = nestedRecordArrayDiffCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const pathPrefix = path.map((segment) => JSON.stringify(segment)).join(',');
  const prefix = pathPrefix === '' ? '' : pathPrefix + ',';
  const startPath = pathPrefix === '' ? '[]' : '[' + pathPrefix + ']';
  const singleRowPath = '[' + prefix + 'batchIndexes[0]]';
  const singleKeyPath = '[' + prefix + 'batchIndexes[0],singleKey]';
  const lines = [
    'return function compiledNestedRecordArrayDiff(source,target,patch){',
    'if(!Array.isArray(source)||!Array.isArray(target))return false;',
    'const length=source.length;',
    'if(length!==target.length)return false;',
    'const startLength=patch.length;',
    'let batchIndexes=null;',
    'let batchValues=null;',
    'function flushBatch(){if(batchIndexes!==null){if(batchIndexes.length===1){const singleAssign=batchValues[0];const singleKeys=Object.keys(singleAssign);if(singleKeys.length===1){const singleKey=singleKeys[0];patch[patch.length]=[OP_SET,' + singleKeyPath + ',singleAssign[singleKey]];}else{patch[patch.length]=[OP_ASSIGN,' + singleRowPath + ',singleAssign];}}else if(!tryEmitObjectAssignAsFieldAssign(patch,' + startPath + ',batchIndexes,batchValues)){patch[patch.length]=[OP_ARRAY_OBJECT_ASSIGN,' + startPath + ',batchIndexes,batchValues];}batchIndexes=null;batchValues=null;}}',
    'for(let i=0;i<length;i++){',
    'const sr=source[i];',
    'const tr=target[i];',
    'if(sr===null||tr===null||typeof sr!=="object"||typeof tr!=="object"||Array.isArray(sr)||Array.isArray(tr)){patch.length=startLength;return false;}'
  ];

  if (key !== undefined) {
    const keyLiteral = JSON.stringify(key);
    lines.push(
      'const sk=sr[' + keyLiteral + '];',
      'const tk=tr[' + keyLiteral + '];',
      'if((sk!==tk)||(sk===0&&1/sk!==1/tk)){patch.length=startLength;return false;}'
    );
  }

  const parentPrefixes = readNestedParentPrefixes(fields);
  const sourceParents = new Map();
  const targetParents = new Map();
  const nestedTopKeyStates = new Map();
  for (let i = 0; i < parentPrefixes.length; i++) {
    const parentPath = parentPrefixes[i];
    const sourceParent = 'sp' + i;
    const targetParent = 'tp' + i;
    sourceParents.set(pathKey(parentPath), sourceParent);
    targetParents.set(pathKey(parentPath), targetParent);
    appendNestedParentRead(lines, 'sr', parentPath, sourceParent);
    appendNestedParentRead(lines, 'tr', parentPath, targetParent);
  }

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.path.length <= 1) continue;
    const topKey = field.path[0];
    const topKeyStateKey = String(topKey);
    if (!nestedTopKeyStates.has(topKeyStateKey)) {
      const index = nestedTopKeyStates.size;
      nestedTopKeyStates.set(topKeyStateKey, {
        count: 'nestedCount' + index,
        value: 'nestedValue' + index,
        path: 'nestedPath' + index,
        key: topKey
      });
    }
  }

  lines.push('let assign=null;');
  nestedTopKeyStates.forEach((entry) => {
    lines.push(
      'let ' + entry.count + '=0;',
      'let ' + entry.value + ';',
      'let ' + entry.path + ';'
    );
  });

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (key !== undefined && field.path.length === 1 && field.path[0] === key) continue;

    const sourceName = 's' + i;
    const targetName = 't' + i;
    appendPlannedValueRead(lines, 'sr', field.path, sourceName, sourceParents);
    appendPlannedValueRead(lines, 'tr', field.path, targetName, targetParents);
    lines.push(
      'if((' + sourceName + '!==' + targetName + ')||(' + sourceName + '===0&&1/' + sourceName + '!==1/' + targetName + ')){'
    );
    if (field.path.length === 1) {
      const literal = JSON.stringify(field.path[0]);
      const nestedEntry = nestedTopKeyStates.get(String(field.path[0]));
      lines.push(
        'if(assign===null)assign={};',
        'assign[' + literal + ']=clonePayload(' + targetName + ');'
      );
      if (nestedEntry !== undefined) {
        lines.push(nestedEntry.count + '=2;');
      }
    } else {
      const entry = nestedTopKeyStates.get(String(field.path[0]));
      const topLiteral = JSON.stringify(field.path[0]);
      lines.push(
        'if(' + entry.count + '===0){' + entry.value + '=' + targetName + ';' + entry.path + '=' + makeGeneratedRecordPath(path, 'i', field.path) + ';}',
        entry.count + '++;',
        'if(' + entry.count + '===2){',
        'if(assign===null)assign={};',
        'assign[' + topLiteral + ']=clonePayload(tr[' + topLiteral + ']);',
        '}'
      );
    }
    lines.push('}');
  }

  lines.push(
    'if(assign!==null){if(batchIndexes===null){batchIndexes=[];batchValues=[];}batchIndexes[batchIndexes.length]=i;batchValues[batchValues.length]=assign;}',
  );
  nestedTopKeyStates.forEach((entry) => {
    lines.push(
      'if(' + entry.count + '===1){flushBatch();patch[patch.length]=[OP_SET,' + entry.path + ',clonePayload(' + entry.value + ')];}'
    );
  });
  lines.push(
    '}',
    'flushBatch();',
    'return true;',
    '}'
  );

  try {
    const compiled = Function(
      'OP_SET',
      'OP_ASSIGN',
      'OP_ARRAY_OBJECT_ASSIGN',
      'clonePayload',
      'hasOwn',
      'tryEmitObjectAssignAsFieldAssign',
      lines.join('\n')
    )(
      OP_SET,
      OP_ASSIGN,
      OP_ARRAY_OBJECT_ASSIGN,
      clonePayload,
      hasOwn,
      tryEmitObjectAssignAsFieldAssign
    );
    rememberCompiledPlan(nestedRecordArrayDiffCache, cacheKey, compiled);
    return compiled;
  } catch {
    return null;
  }
}

function compileFlatObjectDiff(path, fields) {
  const cacheKey = makeCompiledPlanCacheKey('object', path, fields, undefined);
  const cached = flatObjectDiffCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const pathPrefix = path.map((segment) => JSON.stringify(segment)).join(',');
  const rootPath = pathPrefix === '' ? '[]' : '[' + pathPrefix + ']';
  const singleKeyPath = pathPrefix === '' ? '[singleKey]' : '[' + pathPrefix + ',singleKey]';
  const lines = [
    'return function compiledFlatObjectDiff(source,target,patch){',
    'if(source===null||target===null||typeof source!=="object"||typeof target!=="object"||Array.isArray(source)||Array.isArray(target))return false;',
    'const startLength=patch.length;',
    'let assign=null;',
    'let changeCount=0;',
    'let changeKey;',
    'let changeValue;'
  ];

  for (let i = 0; i < fields.length; i++) {
    const literal = JSON.stringify(fields[i]);
    const sourceName = 's' + i;
    const targetName = 't' + i;
    lines.push(
      'const ' + sourceName + '=source[' + literal + '];',
      'const ' + targetName + '=target[' + literal + '];',
      'if((' + sourceName + '!==' + targetName + ')||(' + sourceName + '===0&&1/' + sourceName + '!==1/' + targetName + ')){',
      'if(!canAssignPlannedValue(' + sourceName + ',' + targetName + ')){patch.length=startLength;return false;}',
      'changeCount++;',
      'if(changeCount===1){changeKey=' + literal + ';changeValue=' + targetName + ';}else{',
      'if(assign===null){assign={};assign[changeKey]=clonePayload(changeValue);}',
      'assign[' + literal + ']=clonePayload(' + targetName + ');',
      '}',
      '}'
    );
  }

  lines.push(
    'if(changeCount===1){const singleKey=changeKey;patch[patch.length]=[OP_SET,' + singleKeyPath + ',clonePayload(changeValue)];}',
    'else if(changeCount>1){patch[patch.length]=[OP_ASSIGN,' + rootPath + ',assign];}',
    'return true;',
    '}'
  );

  try {
    const compiled = Function(
      'OP_SET',
      'OP_ASSIGN',
      'clonePayload',
      'canAssignPlannedValue',
      lines.join('\n')
    )(OP_SET, OP_ASSIGN, clonePayload, canAssignPlannedValue);
    rememberCompiledPlan(flatObjectDiffCache, cacheKey, compiled);
    return compiled;
  } catch {
    return null;
  }
}

function compileFlatObjectEquals(fields) {
  const cacheKey = makeCompiledPlanCacheKey('objectEquals', [], fields, undefined);
  const cached = flatObjectEqualsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const lines = [
    'return function compiledFlatObjectEquals(source,target){',
    'if(source===null||target===null||typeof source!=="object"||typeof target!=="object"||Array.isArray(source)||Array.isArray(target))return false;'
  ];

  for (let i = 0; i < fields.length; i++) {
    const literal = JSON.stringify(fields[i]);
    const sourceName = 's' + i;
    const targetName = 't' + i;
    lines.push(
      'const ' + sourceName + '=source[' + literal + '];',
      'const ' + targetName + '=target[' + literal + '];',
      'if((' + sourceName + '!==' + targetName + ')||(' + sourceName + '===0&&1/' + sourceName + '!==1/' + targetName + '))return false;'
    );
  }

  lines.push(
    'return true;',
    '}'
  );

  try {
    const compiled = Function(lines.join('\n'))();
    rememberCompiledPlan(flatObjectEqualsCache, cacheKey, compiled);
    return compiled;
  } catch {
    return null;
  }
}

function compileNestedObjectEquals(fields) {
  const cacheKey = makeCompiledPlanCacheKey('objectNestedEquals', [], fields.map((field) => field.path), undefined);
  const cached = nestedObjectEqualsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const lines = [
    'return function compiledNestedObjectEquals(source,target){',
    'if(source===null||target===null||typeof source!=="object"||typeof target!=="object"||Array.isArray(source)||Array.isArray(target))return false;'
  ];

  const parentPrefixes = readNestedParentPrefixes(fields);
  const sourceParents = new Map();
  const targetParents = new Map();
  for (let i = 0; i < parentPrefixes.length; i++) {
    const parentPath = parentPrefixes[i];
    const sourceParent = 'sp' + i;
    const targetParent = 'tp' + i;
    sourceParents.set(pathKey(parentPath), sourceParent);
    targetParents.set(pathKey(parentPath), targetParent);
    appendNestedParentEqualsRead(lines, 'source', parentPath, sourceParent);
    appendNestedParentEqualsRead(lines, 'target', parentPath, targetParent);
  }

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const sourceName = 's' + i;
    const targetName = 't' + i;
    appendPlannedValueRead(lines, 'source', field.path, sourceName, sourceParents);
    appendPlannedValueRead(lines, 'target', field.path, targetName, targetParents);
    appendPlannedEqualsCompare(lines, sourceName, targetName);
  }

  lines.push(
    'return true;',
    '}'
  );

  try {
    const compiled = Function('equalsJsonFast', lines.join('\n'))(equalsJsonFast);
    rememberCompiledPlan(nestedObjectEqualsCache, cacheKey, compiled);
    return compiled;
  } catch {
    return null;
  }
}

function compileNestedObjectDiff(path, fields) {
  const cacheKey = makeCompiledPlanCacheKey('objectNested', path, fields.map((field) => field.path), undefined);
  const cached = nestedObjectDiffCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const pathPrefix = path.map((segment) => JSON.stringify(segment)).join(',');
  const rootPath = pathPrefix === '' ? '[]' : '[' + pathPrefix + ']';
  const singleKeyPath = pathPrefix === '' ? '[singleKey]' : '[' + pathPrefix + ',singleKey]';
  const lines = [
    'return function compiledNestedObjectDiff(source,target,patch){',
    'if(source===null||target===null||typeof source!=="object"||typeof target!=="object"||Array.isArray(source)||Array.isArray(target))return false;',
    'const startLength=patch.length;',
    'let assign=null;',
    'let changeCount=0;',
    'let changeKey;',
    'let changeValue;'
  ];

  const parentPrefixes = readNestedParentPrefixes(fields);
  const sourceParents = new Map();
  const targetParents = new Map();
  for (let i = 0; i < parentPrefixes.length; i++) {
    const parentPath = parentPrefixes[i];
    const sourceParent = 'sp' + i;
    const targetParent = 'tp' + i;
    sourceParents.set(pathKey(parentPath), sourceParent);
    targetParents.set(pathKey(parentPath), targetParent);
    appendNestedParentRead(lines, 'source', parentPath, sourceParent);
    appendNestedParentRead(lines, 'target', parentPath, targetParent);
  }

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const sourceName = 's' + i;
    const targetName = 't' + i;
    appendPlannedValueRead(lines, 'source', field.path, sourceName, sourceParents);
    appendPlannedValueRead(lines, 'target', field.path, targetName, targetParents);
    lines.push(
      'if((' + sourceName + '!==' + targetName + ')||(' + sourceName + '===0&&1/' + sourceName + '!==1/' + targetName + ')){'
    );
    if (field.path.length === 1) {
      const literal = JSON.stringify(field.path[0]);
      lines.push(
        'if(!canAssignPlannedValue(' + sourceName + ',' + targetName + ')){patch.length=startLength;return false;}',
        'changeCount++;',
        'if(changeCount===1){changeKey=' + literal + ';changeValue=' + targetName + ';}else{',
        'if(assign===null){assign={};assign[changeKey]=clonePayload(changeValue);}',
        'assign[' + literal + ']=clonePayload(' + targetName + ');',
        '}'
      );
    } else {
      lines.push(
        'patch[patch.length]=[OP_SET,' + makeGeneratedObjectPath(path, field.path) + ',clonePayload(' + targetName + ')];'
      );
    }
    lines.push('}');
  }

  lines.push(
    'if(changeCount===1){const singleKey=changeKey;patch[patch.length]=[OP_SET,' + singleKeyPath + ',clonePayload(changeValue)];}',
    'else if(changeCount>1){patch[patch.length]=[OP_ASSIGN,' + rootPath + ',assign];}',
    'return true;',
    '}'
  );

  try {
    const compiled = Function(
      'OP_SET',
      'OP_ASSIGN',
      'clonePayload',
      'canAssignPlannedValue',
      'hasOwn',
      lines.join('\n')
    )(OP_SET, OP_ASSIGN, clonePayload, canAssignPlannedValue, hasOwn);
    rememberCompiledPlan(nestedObjectDiffCache, cacheKey, compiled);
    return compiled;
  } catch {
    return null;
  }
}

function readNestedParentPrefixes(fields) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const path = fields[i].path;
    for (let length = 1; length < path.length; length++) {
      const prefix = path.slice(0, length);
      const key = pathKey(prefix);
      if (!seen.has(key)) {
        seen.add(key);
        out[out.length] = prefix;
      }
    }
  }
  out.sort(comparePath);
  return out;
}

function appendNestedParentRead(lines, root, path, name) {
  let base = root;
  for (let i = 0; i < path.length; i++) {
    const next = i === path.length - 1 ? name : name + 'p' + i;
    const literal = JSON.stringify(path[i]);
    lines.push(
      'const ' + next + '=' + base + '[' + literal + '];',
      'if(' + next + '===null||typeof ' + next + '!=="object"||Array.isArray(' + next + ')){patch.length=startLength;return false;}'
    );
    base = next;
  }
}

function appendNestedParentEqualsRead(lines, root, path, name) {
  let base = root;
  for (let i = 0; i < path.length; i++) {
    const next = i === path.length - 1 ? name : name + 'p' + i;
    const literal = JSON.stringify(path[i]);
    lines.push(
      'const ' + next + '=' + base + '[' + literal + '];',
      'if(' + next + '===null||typeof ' + next + '!=="object"||Array.isArray(' + next + '))return false;'
    );
    base = next;
  }
}

function appendPlannedValueRead(lines, root, path, name, parents) {
  const parentPath = path.length > 1 ? path.slice(0, path.length - 1) : null;
  const base = parentPath === null ? root : parents.get(pathKey(parentPath));
  const literal = JSON.stringify(path[path.length - 1]);
  lines.push('const ' + name + '=' + base + '[' + literal + '];');
}

function appendPlannedEqualsCompare(lines, sourceName, targetName) {
  lines.push(
    'if((' + sourceName + '!==' + targetName + ')||(' + sourceName + '===0&&1/' + sourceName + '!==1/' + targetName + ')){',
    'if(' + sourceName + '===null||' + targetName + '===null||typeof ' + sourceName + '!=="object"||typeof ' + targetName + '!=="object"||!equalsJsonFast(' + sourceName + ',' + targetName + '))return false;',
    '}'
  );
}

function pathKey(path) {
  return path.join('\0');
}

function makeGeneratedRecordPath(prefix, indexExpression, suffix) {
  const parts = [];
  for (let i = 0; i < prefix.length; i++) parts[parts.length] = JSON.stringify(prefix[i]);
  parts[parts.length] = indexExpression;
  for (let i = 0; i < suffix.length; i++) parts[parts.length] = JSON.stringify(suffix[i]);
  return '[' + parts.join(',') + ']';
}

function makeGeneratedObjectPath(prefix, suffix) {
  const parts = [];
  for (let i = 0; i < prefix.length; i++) parts[parts.length] = JSON.stringify(prefix[i]);
  for (let i = 0; i < suffix.length; i++) parts[parts.length] = JSON.stringify(suffix[i]);
  return '[' + parts.join(',') + ']';
}

function makeCompiledPlanCacheKey(kind, path, fields, key) {
  return kind + '\u0001' + JSON.stringify(path) + '\u0001' + JSON.stringify(fields) + '\u0001' + JSON.stringify(key);
}

function rememberCompiledPlan(cache, key, compiled) {
  if (cache.size >= COMPILED_PLAN_CACHE_LIMIT && !cache.has(key)) {
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
  cache.set(key, compiled);
}

function readOwnValue(value, key) {
  return hasOwn.call(value, key) ? value[key] : MISSING_PLAN_VALUE;
}

function canAssignPlannedValue(source, target) {
  if (source !== null && target !== null && typeof source === 'object' && typeof target === 'object') {
    return false;
  }
  return !(typeof source === 'string' && typeof target === 'string' && (source.length >= 32 || target.length >= 32));
}

function comparePlannedFieldValues(
  sourceValue,
  targetValue,
  quantization: QuantizationContext,
  path: JsonPath
): { same: boolean; targetValue: unknown } {
  const rule = typeof targetValue === 'number' && Number.isFinite(targetValue)
    ? findQuantizationRule(quantization, path)
    : null;
  if (rule === null) {
    return { same: sameJsonValue(sourceValue, targetValue), targetValue };
  }

  const quantizedTarget = quantizeNumber(targetValue, rule);
  if (typeof sourceValue !== 'number' || !Number.isFinite(sourceValue)) {
    return { same: false, targetValue: quantizedTarget };
  }
  return {
    same: sameJsonValue(quantizeNumber(sourceValue, rule), quantizedTarget),
    targetValue: quantizedTarget
  };
}

function findQuantizationRule(quantization: QuantizationContext, path: JsonPath): NumericQuantizationRule | null {
  const rules = quantization.rules;
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule.path === undefined || rule.path.length === 0 || quantizationPathMatches(rule.path, path)) return rule;
  }
  return null;
}

function quantizationPathMatches(rulePath: JsonPath, path: JsonPath): boolean {
  if (rulePath.length !== path.length) return false;
  for (let i = 0, length = rulePath.length; i < length; i++) {
    const segment = rulePath[i];
    if (segment !== '*' && segment !== path[i]) return false;
  }
  return true;
}

function quantizeNumber(value: number, rule: NumericQuantizationRule): number {
  const step = rule.step;
  const offset = rule.offset === undefined ? 0 : rule.offset;
  const scaled = (value - offset) / step;
  let bucket;
  if (rule.mode === 'floor') {
    bucket = Math.floor(scaled);
  } else if (rule.mode === 'ceil') {
    bucket = Math.ceil(scaled);
  } else {
    bucket = Math.round(scaled);
  }
  const quantized = roundQuantizedNumber(offset + bucket * step);
  return Object.is(quantized, -0) ? 0 : quantized;
}

function roundQuantizedNumber(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * 1e12) / 1e12;
}

function makePlannedObjectFieldPath(plan, fieldPath: JsonPath): JsonPath {
  return makeObjectPath(plan.path, fieldPath);
}

function makePlannedRecordFieldPath(plan, fieldPath: JsonPath): JsonPath {
  const out = plan.path.slice();
  out[out.length] = '*';
  for (let i = 0, length = fieldPath.length; i < length; i++) out[out.length] = fieldPath[i];
  return out;
}

function makeObjectPath(prefix, suffix) {
  if (!Array.isArray(suffix)) {
    if (prefix.length === 0) return [suffix];
    const out = prefix.slice();
    out[out.length] = suffix;
    return out;
  }
  if (prefix.length === 0) return suffix.slice();
  const out = prefix.slice();
  for (let i = 0; i < suffix.length; i++) out[out.length] = suffix[i];
  return out;
}

function makeRecordPath(prefix, index, suffix?) {
  const prefixLength = prefix.length;
  if (suffix === undefined) {
    if (prefixLength === 0) return [index];
    const out = prefix.slice();
    out[out.length] = index;
    return out;
  }
  if (!Array.isArray(suffix)) {
    if (prefixLength === 0) return [index, suffix];
    const out = prefix.slice();
    out[out.length] = index;
    out[out.length] = suffix;
    return out;
  }
  if (prefixLength === 0) {
    const out = new Array(suffix.length + 1);
    out[0] = index;
    for (let i = 0; i < suffix.length; i++) out[i + 1] = suffix[i];
    return out;
  }
  const out = prefix.slice();
  out[out.length] = index;
  for (let i = 0; i < suffix.length; i++) out[out.length] = suffix[i];
  return out;
}

function sameJsonValue(left, right) {
  return left === right && (left !== 0 || 1 / left === 1 / right);
}

function createProfileSnapshot(
  options,
  maxEntries,
  baseSchemaPlan,
  profilePlan,
  profilePlans: ProfilePlans | undefined,
  adaptive,
  historyStrategy: HistoryPlanStrategy | null
): DiffProfile {
  const schemas = [];
  appendPlanSchemas(baseSchemaPlan, schemas);
  appendPlanSchemas(profilePlan, schemas);
  const adaptivePlan = readAdaptivePlan(adaptive);
  appendPlanSchemas(adaptivePlan, schemas);

  const settings = createProfileSettings(options, maxEntries, adaptive);
  const profile: DiffProfile = { version: PROFILE_VERSION as 1 };
  if (Object.keys(settings).length !== 0) profile.settings = settings;
  const plans = createEngineProfilePlansSnapshot(profilePlans, {
    settings,
    schemaCount: schemas.length,
    schemaPaths: readProfileSchemaPaths(schemas),
    adaptivePlan: adaptivePlan !== null,
    historyStrategy
  });
  if (plans !== undefined) profile.plans = plans;
  if (schemas.length === 1) {
    profile.schema = schemas[0];
  } else if (schemas.length > 1) {
    profile.schemas = schemas;
  }
  return profile;
}

function readProfileSchemaPaths(schemas): JsonPath[] | undefined {
  if (schemas.length === 0) return undefined;
  const paths = [];
  for (let i = 0, length = schemas.length; i < length; i++) {
    const path = schemas[i].path;
    if (Array.isArray(path)) paths[paths.length] = path.slice();
    else paths[paths.length] = [];
  }
  return paths;
}

function createProfileSettings(options, maxEntries, adaptive) {
  const settings: ProfileSettingsSnapshot = {};
  if (maxEntries !== DEFAULT_MAX_ENTRIES) settings.cacheSize = maxEntries;
  if (adaptive !== null && adaptive.enabled) {
    settings.adaptive = true;
    if (adaptive.thresholdExplicit || adaptive.threshold !== DEFAULT_ADAPTIVE_THRESHOLD) {
      settings.adaptiveThreshold = adaptive.threshold;
    }
  } else if (options && options.adaptive === false) {
    settings.adaptive = false;
  }

  if (options) {
    copyProfileSetting(settings, options, 'arrayKey', isJsonProfileScalarOrFalse);
    copyProfileSetting(settings, options, 'autoArrayKey', isBoolean);
    copyProfileSetting(settings, options, 'recordKeyCandidates', isPortablePolicyKeys);
    copyProfileSetting(settings, options, 'containerKeys', isPortablePolicyKeys);
    copyProfileSetting(settings, options, 'stable', isBoolean);
    copyProfileSetting(settings, options, 'sortKeys', isBoolean);
    copyProfileSetting(settings, options, 'maxPatchOperations', isNonNegativeSafeIntegerOrNull);
    copyProfileSetting(settings, options, 'versionKey', isJsonProfileScalar);
    copyProfileSetting(settings, options, 'fingerprintKey', isJsonProfileScalar);
    const quantization = readQuantizationRules(options.quantization, 'quantization');
    if (quantization !== undefined && quantization.length !== 0) settings.quantization = quantization;
  }

  return settings;
}

function copyProfileSetting(settings, options, key, predicate) {
  if (options[key] !== undefined && predicate(options[key])) {
    settings[key] = options[key];
  }
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

function isNonNegativeSafeIntegerOrNull(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function isJsonProfileScalarOrFalse(value) {
  return value === false || isJsonProfileScalar(value);
}

function isJsonProfileScalar(value) {
  return typeof value === 'string' || typeof value === 'number';
}

function isPortablePolicyKeys(value) {
  if (value === false || value === null) return true;
  if (!Array.isArray(value)) return false;
  for (let i = 0, length = value.length; i < length; i++) {
    if (!isJsonProfileScalar(value[i])) return false;
  }
  return true;
}

function appendPlanSchemas(plan, schemas) {
  if (plan === null || plan === undefined) return;
  if (plan.type === 'multi') {
    for (let i = 0, length = plan.plans.length; i < length; i++) {
      appendPlanSchemas(plan.plans[i], schemas);
    }
    return;
  }
  if (plan.schema !== undefined) schemas[schemas.length] = clonePayload(plan.schema);
}

function createAdaptiveState(options) {
  if (!options || !options.adaptive) return null;
  const thresholdExplicit = options.adaptiveThreshold !== undefined;
  const threshold = options.adaptiveThreshold === undefined
    ? DEFAULT_ADAPTIVE_THRESHOLD
    : options.adaptiveThreshold;
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new TypeError('adaptiveThreshold option must be a positive safe integer');
  }
  return {
    enabled: true,
    threshold,
    thresholdExplicit,
    recordKeyCandidates: readPolicyKeys(options.recordKeyCandidates, 'recordKeyCandidates'),
    containerKeys: readPolicyKeys(options.containerKeys, 'containerKeys'),
    plan: null,
    candidates: new Map(),
    learnedKeys: new Set(),
    rejectedKeys: new Set(),
    deferredObjectSignatures: new Set(),
    failedPlanPairs: new WeakMap(),
    failedPlanPairsActive: false,
    failedPlanSignatures: new Set(),
    failedPlanSignatureOrder: []
  };
}

function readPolicyKeys(value, name) {
  if (value === undefined) return undefined;
  if (value === false || value === null) return null;
  if (!Array.isArray(value)) {
    throw new TypeError(name + ' option must be an array of strings/numbers or false');
  }
  const out = new Array(value.length);
  for (let i = 0, length = value.length; i < length; i++) {
    const key = value[i];
    if (typeof key !== 'string' && typeof key !== 'number') {
      throw new TypeError(name + ' entries must be strings or numbers');
    }
    out[i] = key;
  }
  return out;
}

function readAdaptivePlan(state) {
  return state !== null && state.enabled ? state.plan : null;
}

function planCoversRoot(plan): boolean {
  if (plan.type === 'multi') {
    for (let i = 0, length = plan.plans.length; i < length; i++) {
      if (planCoversRoot(plan.plans[i])) return true;
    }
    return false;
  }
  return plan.path.length === 0;
}

function hasAdaptiveFailedPlan(state, plan, source, target) {
  if (state === null || !state.failedPlanPairsActive) return false;
  if (hasAdaptiveFailedPlanPair(state, source, target)) return true;
  const signature = readAdaptiveFailedPlanSignature(plan, source, target);
  return signature !== null && state.failedPlanSignatures.has(signature);
}

function hasAdaptiveFailedPlanPair(state, source, target) {
  if (state === null || !state.failedPlanPairsActive) return false;
  if (!canUseWeakMapKey(source) || !canUseWeakMapKey(target)) return false;
  const targets = state.failedPlanPairs.get(source);
  return targets !== undefined && targets.has(target);
}

function rememberAdaptiveFailedPlan(state, plan, source, target) {
  if (state === null) return;
  rememberAdaptiveFailedPlanPair(state, source, target);
  const signature = readAdaptiveFailedPlanSignature(plan, source, target);
  if (signature !== null) {
    rememberAdaptiveFailedPlanSignature(state, signature);
    state.failedPlanPairsActive = true;
  }
}

function rememberAdaptiveFailedPlanPair(state, source, target) {
  if (!canUseWeakMapKey(source) || !canUseWeakMapKey(target)) return;
  let targets = state.failedPlanPairs.get(source);
  if (targets === undefined) {
    targets = new WeakSet();
    state.failedPlanPairs.set(source, targets);
  }
  targets.add(target);
  state.failedPlanPairsActive = true;
}

function rememberAdaptiveFailedPlanSignature(state, signature) {
  if (state.failedPlanSignatures.has(signature)) return;
  state.failedPlanSignatures.add(signature);
  state.failedPlanSignatureOrder[state.failedPlanSignatureOrder.length] = signature;
  if (state.failedPlanSignatureOrder.length > ADAPTIVE_FAILED_PLAN_SIGNATURE_LIMIT) {
    const dropped = state.failedPlanSignatureOrder.shift();
    if (dropped !== undefined) state.failedPlanSignatures.delete(dropped);
  }
}

function clearAdaptiveFailedPlanPairs(state) {
  if (state === null || !state.failedPlanPairsActive) return;
  state.failedPlanPairs = new WeakMap();
  state.failedPlanSignatures.clear();
  state.failedPlanSignatureOrder.length = 0;
  state.failedPlanPairsActive = false;
}

function canUseWeakMapKey(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function readAdaptiveFailedPlanSignature(plan, source, target) {
  const parts = [];
  return appendAdaptiveFailedPlanSignature(plan, source, target, parts)
    ? parts.join('\u0001')
    : null;
}

function appendAdaptiveFailedPlanSignature(plan, source, target, parts) {
  if (plan.type === 'multi') {
    let invalid = false;
    parts[parts.length] = 'm';
    parts[parts.length] = plan.plans.length;
    for (let i = 0, length = plan.plans.length; i < length; i++) {
      if (appendAdaptiveFailedPlanSignature(plan.plans[i], source, target, parts)) invalid = true;
    }
    return invalid;
  }

  const sourceValue = readPlanPathValue(source, plan.path);
  const targetValue = readPlanPathValue(target, plan.path);
  parts[parts.length] = plan.type;
  parts[parts.length] = pathKey(plan.path);
  if (plan.type === 'recordArray') {
    return appendRecordArrayFailedPlanSignature(plan, sourceValue, targetValue, parts);
  }
  return appendObjectFailedPlanSignature(plan, sourceValue, targetValue, parts);
}

function appendRecordArrayFailedPlanSignature(plan, source, target, parts) {
  if (!Array.isArray(source) || !Array.isArray(target)) {
    parts[parts.length] = readPlanValueKind(source);
    parts[parts.length] = readPlanValueKind(target);
    return true;
  }

  const sourceLength = source.length;
  const targetLength = target.length;
  let invalid = plan.key === undefined && sourceLength !== targetLength;
  parts[parts.length] = sourceLength;
  parts[parts.length] = targetLength;
  parts[parts.length] = plan.key === undefined ? '' : String(plan.key);
  const sampleIndexes = readAdaptiveArraySampleIndexes(sourceLength, targetLength);
  for (let i = 0, length = sampleIndexes.length; i < length; i++) {
    const index = sampleIndexes[i];
    parts[parts.length] = index;
    if (index >= 0 && index < sourceLength) {
      if (appendRecordRowGuardSignature(plan, source[index], parts)) invalid = true;
    } else {
      parts[parts.length] = 'source-out';
    }
    if (index >= 0 && index < targetLength) {
      if (appendRecordRowGuardSignature(plan, target[index], parts)) invalid = true;
    } else {
      parts[parts.length] = 'target-out';
    }
  }
  return invalid;
}

function appendObjectFailedPlanSignature(plan, source, target, parts) {
  let invalid = false;
  if (appendObjectGuardSignature(plan, source, parts)) invalid = true;
  if (appendObjectGuardSignature(plan, target, parts)) invalid = true;
  return invalid;
}

function readAdaptiveArraySampleIndexes(sourceLength, targetLength) {
  const maxLength = sourceLength > targetLength ? sourceLength : targetLength;
  if (maxLength <= 0) return [];
  if (maxLength === 1) return [0];
  const mid = maxLength >> 1;
  return mid === 0 || mid === maxLength - 1 ? [0, maxLength - 1] : [0, mid, maxLength - 1];
}

function appendRecordRowGuardSignature(plan, row, parts) {
  if (!isPlanRecordRow(row)) {
    parts[parts.length] = readPlanValueKind(row);
    return true;
  }

  let invalid = false;
  if (plan.exact === true && !exactObjectMatchesSchema(row, plan.schema && plan.schema.item && plan.schema.item.fields)) {
    invalid = true;
  }
  if (plan.key !== undefined) {
    const keyValue = readOwnValue(row, plan.key);
    if (keyValue === MISSING_PLAN_VALUE || !isPlannedRecordKeyValue(keyValue)) invalid = true;
    parts[parts.length] = keyValue === MISSING_PLAN_VALUE ? 'km' : typeof keyValue;
  }

  if (appendFieldsGuardSignature(row, plan.fields, parts)) invalid = true;
  return invalid;
}

function appendObjectGuardSignature(plan, value, parts) {
  if (!isPlanRecordRow(value)) {
    parts[parts.length] = readPlanValueKind(value);
    return true;
  }

  let invalid = false;
  if (plan.exact === true && !exactObjectMatchesSchema(value, plan.schema && plan.schema.fields)) {
    invalid = true;
  }

  return appendFieldsGuardSignature(value, plan.fields, parts) || invalid;
}

function appendFieldsGuardSignature(value, fields, parts) {
  let invalid = false;
  let mask = 0;
  const limit = fields.length < 30 ? fields.length : 30;
  for (let i = 0; i < limit; i++) {
    const field = fields[i];
    const fieldValue = field.path.length === 1
      ? readOwnValue(value, field.path[0])
      : readPlanPathValue(value, field.path);
    if (fieldValue !== MISSING_PLAN_VALUE) {
      mask |= 1 << i;
    } else {
      invalid = true;
    }
  }
  parts[parts.length] = fields.length;
  parts[parts.length] = mask;
  return invalid;
}

function readPlanValueKind(value) {
  if (value === MISSING_PLAN_VALUE) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function observeAdaptiveShape(state, source, target) {
  if (state === null || !state.enabled) return false;
  if (shouldDeferWideRootObjectObservation(state, source, target)) {
    return false;
  }

  const shapes = readAdaptiveShapes(source, target);
  if (shapes.length === 0) {
    return false;
  }

  let changed = false;
  for (let i = 0, length = shapes.length; i < length; i++) {
    const shape = shapes[i];
    if (!isAdaptiveShapeSupported(shape)) continue;

    const key = makeAdaptiveShapeKey(shape);
    if (state.learnedKeys.has(key) || state.rejectedKeys.has(key)) continue;
    if (hasAdaptivePlanPathConflict(state.plan, shape.path)) {
      state.rejectedKeys.add(key);
      continue;
    }

    let entry = state.candidates.get(key);
    const score = scoreAdaptiveShape(shape);
    const initialHits = readInitialAdaptiveShapeHits(state, shape);
    if (entry === undefined) {
      entry = { shape, hits: initialHits, score };
      state.candidates.set(key, entry);
    } else {
      entry.hits += initialHits;
      if (score > entry.score) {
        entry.shape = shape;
        entry.score = score;
      }
    }

    if (entry.hits >= readAdaptiveShapeThreshold(state, shape)) {
      const plan = createPlanFromAdaptiveShape(entry.shape, state.recordKeyCandidates);
      const merged = plan === null ? null : appendAdaptivePlan(state.plan, plan);
      state.candidates.delete(key);
      if (merged === null) {
        state.rejectedKeys.add(key);
      } else {
        state.plan = merged;
        state.learnedKeys.add(key);
        clearAdaptiveFailedPlanPairs(state);
        changed = true;
      }
    }
  }

  return changed;
}

function readAdaptiveShapeThreshold(state, shape) {
  if (
    shape.kind === 'object' &&
    shape.path.length === 0 &&
    !state.thresholdExplicit &&
    state.threshold < 2
  ) {
    return 2;
  }
  return state.threshold;
}

function shouldDeferWideRootObjectObservation(state, source, target) {
  if (state.thresholdExplicit || state.threshold >= 2) return false;
  if (!isPlainObjectPair(source, target)) return false;
  if (hasAdaptiveContainerCandidate(source, target, state) || hasAnyAdaptiveContainerCandidate(source, target)) return false;

  if (state.deferredObjectSignatures.has(DEFERRED_WIDE_ROOT_OBJECT_SIGNATURE)) return false;
  state.deferredObjectSignatures.add(DEFERRED_WIDE_ROOT_OBJECT_SIGNATURE);
  return true;
}

function readInitialAdaptiveShapeHits(state, shape) {
  if (shape.kind !== 'object') return 1;
  if (
    shape.path.length !== 0 ||
    !state.deferredObjectSignatures.has(DEFERRED_WIDE_ROOT_OBJECT_SIGNATURE)
  ) {
    return 1;
  }
  state.deferredObjectSignatures.delete(DEFERRED_WIDE_ROOT_OBJECT_SIGNATURE);
  return 2;
}

function hasAdaptiveContainerCandidate(source, target, state) {
  const keys = state === null || state.containerKeys === undefined ? null : state.containerKeys;
  if (keys === null) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const sourceValue = source[key];
    const targetValue = target[key];
    if (
      sourceValue !== null &&
      targetValue !== null &&
      typeof sourceValue === 'object' &&
      typeof targetValue === 'object' &&
      hasOwn.call(source, key) &&
      hasOwn.call(target, key)
    ) {
      return true;
    }
  }
  return false;
}

function hasAnyAdaptiveContainerCandidate(source, target) {
  const keys = Object.keys(source);
  for (let i = 0, length = keys.length; i < length; i++) {
    const key = keys[i];
    if (!hasOwn.call(target, key)) continue;
    const sourceValue = source[key];
    const targetValue = target[key];
    if (
      sourceValue !== null &&
      targetValue !== null &&
      typeof sourceValue === 'object' &&
      typeof targetValue === 'object'
    ) {
      return true;
    }
  }
  return false;
}

function trainProfilePlan(samples, recordKeyCandidates?) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError('training samples must be a non-empty array');
  }

  const candidates = new Map<string, TrainingEntry>();
  for (let i = 0, length = samples.length; i < length; i++) {
    const pair = readTrainingPair(samples[i], i);
    const rootShapes = readRootAdaptiveShapes(pair.source, pair.target);
    if (rootShapes !== null) {
      for (let j = 0; j < rootShapes.length; j++) {
        addTrainingShape(candidates, rootShapes[j]);
      }
    } else {
      collectTrainingShapes(pair.source, pair.target, [], 0, candidates);
    }
  }

  const shapes = selectTrainingShapes(candidates);
  if (shapes.length === 0) return null;

  return createPlanFromAdaptiveShapes(shapes, recordKeyCandidates);
}

function createPlanFromAdaptiveShapes(shapes, recordKeyCandidates?) {
  const plans = [];
  for (let i = 0, length = shapes.length; i < length; i++) {
    const plan = createPlanFromAdaptiveShape(shapes[i], recordKeyCandidates);
    if (plan !== null) plans[plans.length] = plan;
  }

  if (plans.length === 0) return null;
  return plans.length === 1
    ? plans[0]
    : {
        type: 'multi',
        plans,
        trie: buildPlanPathTrie(plans),
        schema: { schemas: plans.map((plan) => plan.schema) }
      };
}

function appendAdaptivePlan(existing, next) {
  if (existing === null || existing === undefined) return next;
  const plans = existing.type === 'multi' ? existing.plans.slice() : [existing];
  for (let i = 0, length = plans.length; i < length; i++) {
    if (pathsOverlap(plans[i].path, next.path)) return null;
  }
  plans[plans.length] = next;
  plans.sort(comparePlanPath);
  return {
    type: 'multi',
    plans,
    trie: buildPlanPathTrie(plans),
    schema: { schemas: plans.map((plan) => plan.schema) }
  };
}

function comparePlanPath(left, right) {
  return comparePath(left.path, right.path);
}

function hasAdaptivePlanPathConflict(plan, path) {
  if (plan === null || plan === undefined) return false;
  if (plan.type === 'multi') {
    for (let i = 0, length = plan.plans.length; i < length; i++) {
      if (pathsOverlap(plan.plans[i].path, path)) return true;
    }
    return false;
  }
  return pathsOverlap(plan.path, path);
}

function readTrainingPair(sample, index) {
  if (Array.isArray(sample) && sample.length >= 2) {
    return { source: sample[0], target: sample[1] };
  }

  if (sample !== null && typeof sample === 'object' && !Array.isArray(sample)) {
    if (hasOwn.call(sample, 'source') && hasOwn.call(sample, 'target')) {
      return { source: sample.source, target: sample.target };
    }
    if (hasOwn.call(sample, 'before') && hasOwn.call(sample, 'after')) {
      return { source: sample.before, target: sample.after };
    }
  }

  throw new TypeError('training sample at index ' + index + ' must be [source, target], { source, target }, or { before, after }');
}

function collectTrainingShapes(source, target, path, depth, candidates) {
  const recordArray = readRecordArrayShape(source, target);
  if (recordArray !== null) {
    recordArray.path = path.slice();
    addTrainingShape(candidates, recordArray);
    if (isAdaptiveShapeSupported(recordArray)) return;
  }

  if (Array.isArray(source) || Array.isArray(target)) {
    if (!Array.isArray(source) || !Array.isArray(target) || depth >= TRAINING_MAX_DEPTH) return;
    const length = source.length < target.length ? source.length : target.length;
    const limit = length < ADAPTIVE_SAMPLE_LIMIT ? length : ADAPTIVE_SAMPLE_LIMIT;
    for (let i = 0; i < limit; i++) {
      const sourceValue = source[i];
      const targetValue = target[i];
      if (sourceValue === null || targetValue === null) continue;
      if (typeof sourceValue !== 'object' || typeof targetValue !== 'object') continue;
      const childPath = path.slice();
      childPath[childPath.length] = i;
      collectTrainingShapes(sourceValue, targetValue, childPath, depth + 1, candidates);
    }
    return;
  }

  if (
    path.length !== 0 ||
    !hasAnyAdaptiveContainerCandidate(source, target)
  ) {
    const objectShape = readTrainableObjectShape(source, target, path);
    if (objectShape !== null) addTrainingShape(candidates, objectShape);
  }

  if (depth >= TRAINING_MAX_DEPTH || !isPlainObjectPair(source, target)) return;

  const keys = Object.keys(source);
  for (let i = 0, length = keys.length; i < length; i++) {
    const key = keys[i];
    if (!hasOwn.call(target, key)) continue;
    const sourceValue = source[key];
    const targetValue = target[key];
    if (sourceValue === null || targetValue === null) continue;
    if (typeof sourceValue !== 'object' || typeof targetValue !== 'object') continue;
    const childPath = path.slice();
    childPath[childPath.length] = key;
    collectTrainingShapes(sourceValue, targetValue, childPath, depth + 1, candidates);
  }
}

function addTrainingShape(candidates, shape) {
  if (!isAdaptiveShapeSupported(shape)) return;

  const key = makeAdaptiveShapeKey(shape);
  let entry = candidates.get(key);
  const score = scoreAdaptiveShape(shape);
  if (entry === undefined) {
    candidates.set(key, { shape, hits: 1, score });
  } else {
    entry.hits++;
    if (score > entry.score) {
      entry.shape = shape;
      entry.score = score;
    }
  }
}

function selectTrainingShapes(candidates: Map<string, TrainingEntry>): AdaptiveShape[] {
  const entries = Array.from(candidates.values());
  entries.sort(compareTrainingEntries);

  const selected: AdaptiveShape[] = [];
  for (let i = 0, length = entries.length; i < length && selected.length < TRAINING_MAX_SCHEMAS; i++) {
    const shape = entries[i].shape;
    if (hasSelectedPathConflict(selected, shape.path)) continue;
    selected[selected.length] = shape;
  }

  selected.sort(compareShapePath);
  return selected;
}

function compareTrainingEntries(left, right) {
  const leftScore = left.hits * left.score;
  const rightScore = right.hits * right.score;
  if (leftScore !== rightScore) return rightScore - leftScore;
  if (left.score !== right.score) return right.score - left.score;
  return comparePath(left.shape.path, right.shape.path);
}

function hasSelectedPathConflict(selected, path) {
  for (let i = 0, length = selected.length; i < length; i++) {
    if (pathsOverlap(selected[i].path, path)) return true;
  }
  return false;
}

function pathsOverlap(left, right) {
  const length = left.length < right.length ? left.length : right.length;
  for (let i = 0; i < length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function compareShapePath(left, right) {
  return comparePath(left.path, right.path);
}

function comparePath(left, right) {
  const length = left.length < right.length ? left.length : right.length;
  for (let i = 0; i < length; i++) {
    const a = String(left[i]);
    const b = String(right[i]);
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return left.length - right.length;
}

function readTrainableObjectShape(source, target, path) {
  const fields = readAdaptiveFieldSchemas(source, target, 0);
  if (fields === null) return null;

  return {
    kind: 'object',
    fields,
    path: path.slice()
  };
}

function isPlainObjectPair(source, target) {
  return (
    source !== null &&
    target !== null &&
    typeof source === 'object' &&
    typeof target === 'object' &&
    !Array.isArray(source) &&
    !Array.isArray(target)
  );
}

function createPlanFromAdaptiveShape(shape, recordKeyCandidates?) {
  const fields = shape.fields;
  const fieldCount = countSchemaFields(fields);
  if (
    shape.kind === 'recordArray' &&
    fieldCount >= ADAPTIVE_RECORD_FIELD_MIN &&
    shape.rowCount * fieldCount >= ADAPTIVE_RECORD_CELL_MIN
  ) {
    return createRecordArrayPlan({
      type: 'array',
      path: shape.path,
      key: inferRecordArrayKey(fields, shape.source, shape.target, recordKeyCandidates),
      item: {
        type: 'object',
        fields
      },
      exact: true
    });
  }

  if (
    shape.kind === 'object' &&
    fieldCount >= readAdaptiveObjectFieldMin(shape)
  ) {
    return createObjectPlan({
      type: 'object',
      path: shape.path,
      fields,
      exact: true
    });
  }

  return null;
}

function isAdaptiveShapeSupported(shape) {
  const fieldCount = countSchemaFields(shape.fields);
  if (shape.kind === 'recordArray') {
    return (
      fieldCount >= ADAPTIVE_RECORD_FIELD_MIN &&
      shape.rowCount * fieldCount >= ADAPTIVE_RECORD_CELL_MIN
    );
  }

  return shape.kind === 'object' && fieldCount >= readAdaptiveObjectFieldMin(shape);
}

function readAdaptiveObjectFieldMin(shape) {
  return shape.path.length === 0 ? ADAPTIVE_OBJECT_FIELD_MIN : ADAPTIVE_PATH_OBJECT_FIELD_MIN;
}

function scoreAdaptiveShape(shape) {
  return shape.kind === 'recordArray'
    ? shape.rowCount * countSchemaFields(shape.fields)
    : countSchemaFields(shape.fields);
}

function makeAdaptiveShapeKey(shape) {
  return shape.kind + '\u0001' + shape.path.join('\0') + '\u0001' + JSON.stringify(shape.fields);
}

function clearAdaptiveState(state) {
  if (state === null) return;
  state.plan = null;
  state.candidates.clear();
  state.learnedKeys.clear();
  state.rejectedKeys.clear();
  state.deferredObjectSignatures.clear();
  clearAdaptiveFailedPlanPairs(state);
}

function readAdaptiveShapes(source, target) {
  const rootShapes = readRootAdaptiveShapes(source, target);
  if (rootShapes !== null) return rootShapes;

  const candidates = new Map<string, TrainingEntry>();
  collectTrainingShapes(source, target, [], 0, candidates);
  return selectTrainingShapes(candidates);
}

function readRootAdaptiveShapes(source, target) {
  const recordArray = readRecordArrayShape(source, target);
  if (recordArray !== null) {
    return isAdaptiveShapeSupported(recordArray) ? [recordArray] : [];
  }

  if (isPlainObjectPair(source, target)) {
    if (hasAnyAdaptiveContainerCandidate(source, target)) return null;
  }

  const objectShape = readTrainableObjectShape(source, target, []);
  if (objectShape !== null) {
    return isAdaptiveShapeSupported(objectShape) ? [objectShape] : null;
  }

  return null;
}

function readRecordArrayShape(source, target) {
  if (!Array.isArray(source) || !Array.isArray(target)) return null;
  const length = source.length < target.length ? source.length : target.length;
  if (length === 0 || source.length !== target.length) return null;

  let fields = null;
  const sampleLength = length < ADAPTIVE_SAMPLE_LIMIT ? length : ADAPTIVE_SAMPLE_LIMIT;
  for (let i = 0; i < sampleLength; i++) {
    const sourceFields = readAdaptiveFieldSchemas(source[i], target[i], 0);
    if (sourceFields === null) return null;
    if (fields === null) {
      fields = sourceFields;
    } else if (!sameSchemaFieldList(fields, sourceFields)) {
      return null;
    }
  }

  return { kind: 'recordArray', fields, rowCount: length, source, target, path: [] };
}

function readAdaptiveFieldSchemas(source, target, depth) {
  if (
    source === null ||
    target === null ||
    typeof source !== 'object' ||
    typeof target !== 'object' ||
    Array.isArray(source) ||
    Array.isArray(target)
  ) {
    return null;
  }

  const sourceFields = Object.keys(source);
  const targetFields = Object.keys(target);
  if (!sameFieldList(sourceFields, targetFields)) return null;

  const fields = new Array(sourceFields.length);
  for (let i = 0, length = sourceFields.length; i < length; i++) {
    const key = sourceFields[i];
    const sourceValue = source[key];
    const targetValue = target[key];
    if (
      depth < ADAPTIVE_NESTED_FIELD_DEPTH &&
      isPlainObjectValue(sourceValue) &&
      isPlainObjectValue(targetValue)
    ) {
      const nested = readAdaptiveFieldSchemas(sourceValue, targetValue, depth + 1);
      fields[i] = nested === null
        ? key
        : { key, type: 'object', fields: nested };
    } else {
      fields[i] = key;
    }
  }
  return fields.length === 0 ? null : fields;
}

function inferRecordArrayKey(fields, source, target, recordKeyCandidates?) {
  const key = pickRecordArrayKey(fields, source, target, recordKeyCandidates);
  if (key === undefined) return undefined;

  return key;
}

function pickRecordArrayKey(fields, source, target, recordKeyCandidates?) {
  const policyKey = pickPolicyRecordArrayKey(fields, source, target, recordKeyCandidates);
  if (policyKey !== undefined) return policyKey;

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if ((typeof field === 'string' || typeof field === 'number') && isStableUniqueRecordKey(field, source, target)) {
      return field;
    }
  }
  return undefined;
}

function pickPolicyRecordArrayKey(fields, source, target, recordKeyCandidates) {
  if (recordKeyCandidates === undefined || recordKeyCandidates === null) return undefined;
  for (let i = 0, length = recordKeyCandidates.length; i < length; i++) {
    const key = recordKeyCandidates[i];
    if (hasSchemaField(fields, key) && isStableUniqueRecordKey(key, source, target)) return key;
  }
  return undefined;
}

function hasSchemaField(fields, key) {
  for (let i = 0, length = fields.length; i < length; i++) {
    const field = fields[i];
    if ((typeof field === 'string' || typeof field === 'number') && field === key) return true;
  }
  return false;
}

function isStableUniqueRecordKey(key, source, target) {
  const sampleLength = source.length < ADAPTIVE_SAMPLE_LIMIT ? source.length : ADAPTIVE_SAMPLE_LIMIT;
  const sourceSeen = new Set();
  const targetSeen = new Set();
  for (let i = 0; i < sampleLength; i++) {
    const sourceRow = source[i];
    const targetRow = target[i];
    if (
      sourceRow === null ||
      targetRow === null ||
      typeof sourceRow !== 'object' ||
      typeof targetRow !== 'object' ||
      Array.isArray(sourceRow) ||
      Array.isArray(targetRow) ||
      !hasOwn.call(sourceRow, key) ||
      !hasOwn.call(targetRow, key)
    ) {
      return false;
    }
    const sourceKey = sourceRow[key];
    const targetKey = targetRow[key];
    if (
      !isAdaptiveRecordKeyValue(sourceKey) ||
      !isAdaptiveRecordKeyValue(targetKey) ||
      !sameJsonValue(sourceKey, targetKey) ||
      sourceSeen.has(sourceKey) ||
      targetSeen.has(targetKey)
    ) {
      return false;
    }
    sourceSeen.add(sourceKey);
    targetSeen.add(targetKey);
  }

  return true;
}

function isAdaptiveRecordKeyValue(value) {
  if (typeof value === 'string') return value.length > 0 && value.length <= 256;
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0);
}

function countSchemaFields(fields) {
  let count = 0;
  for (let i = 0, length = fields.length; i < length; i++) {
    const field = fields[i];
    count += typeof field === 'string' || typeof field === 'number'
      ? 1
      : countSchemaFields(field.fields);
  }
  return count;
}

function isPlainObjectValue(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameFieldList(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0, length = left.length; i < length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sameSchemaFieldList(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0, length = left.length; i < length; i++) {
    if (!sameSchemaField(left[i], right[i])) return false;
  }
  return true;
}

function sameSchemaField(left, right) {
  const leftScalar = typeof left === 'string' || typeof left === 'number';
  const rightScalar = typeof right === 'string' || typeof right === 'number';
  if (leftScalar || rightScalar) return leftScalar && rightScalar && left === right;
  return left.key === right.key &&
    left.type === right.type &&
    sameSchemaFieldList(left.fields, right.fields);
}

function lookupPairEntry(cache, source, target, state) {
  if (!isObject(source) || !isObject(target)) return null;
  const byTarget = cache.get(source);
  if (byTarget === undefined) return null;
  const entries = byTarget.get(target);
  if (entries === undefined) return null;
  return lookupEntry(entries, state);
}

function storePairEntry(cache, source, target, entry) {
  if (!isObject(source) || !isObject(target)) return;
  let byTarget = cache.get(source);
  if (byTarget === undefined) {
    byTarget = new WeakMap();
    cache.set(source, byTarget);
  }

  let entries = byTarget.get(target);
  if (entries === undefined) {
    entries = [];
    byTarget.set(target, entries);
  }

  replaceOrAppendEntry(entries, entry);
  if (entries.length > MAX_PAIR_SIGNATURES) entries.shift();
}

function lookupTokenEntry(entries, state) {
  const entry = lookupEntry(entries, state);
  if (entry !== null) {
    const index = entries.indexOf(entry);
    if (index > 0) {
      entries.splice(index, 1);
      entries[entries.length] = entry;
    }
  }
  return entry;
}

function storeTokenEntry(entries, entry, maxEntries) {
  replaceOrAppendEntry(entries, entry);
  while (entries.length > maxEntries) entries.shift();
}

function replaceOrAppendEntry(entries, entry) {
  for (let i = 0, length = entries.length; i < length; i++) {
    if (sameEntryIdentity(entries[i], entry)) {
      entries[i] = entry;
      return;
    }
  }
  entries[entries.length] = entry;
}

function lookupEntry(entries, state) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      Object.is(entry.sourceToken, state.sourceToken) &&
      Object.is(entry.targetToken, state.targetToken) &&
      sameSignature(entry.signature, state.signature)
    ) {
      return entry;
    }
  }
  return null;
}

function sameEntryIdentity(left, right) {
  return Object.is(left.sourceToken, right.sourceToken) &&
    Object.is(left.targetToken, right.targetToken) &&
    sameSignature(left.signature, right.signature);
}

function sameSignature(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0, length = left.length; i < length; i++) {
    if (!Object.is(left[i], right[i])) return false;
  }
  return true;
}

function clonePatch(patch) {
  const out = new Array(patch.length);
  for (let i = 0, length = patch.length; i < length; i++) {
    out[i] = cloneOperation(patch[i]);
  }
  return out;
}

function clonePatchInto(source, target) {
  target.length = source.length;
  for (let i = 0, length = source.length; i < length; i++) {
    target[i] = cloneOperation(source[i]);
  }
  return target;
}

function cloneOperation(op) {
  const code = op[0];
  if (code === OP_SET) {
    return [OP_SET, op[1].slice(), clonePayload(op[2])];
  }
  if (code === OP_REMOVE) {
    return [OP_REMOVE, op[1].slice()];
  }
  if (code === OP_TRUNCATE) {
    return [OP_TRUNCATE, op[1].slice(), op[2]];
  }
  if (code === OP_APPEND) {
    return [OP_APPEND, op[1].slice(), clonePayload(op[2])];
  }
  if (code === OP_SCALAR_ARRAY_REPLACE) {
    return [OP_SCALAR_ARRAY_REPLACE, op[1].slice(), op[2].slice()];
  }
  if (code === OP_ASSIGN) {
    return [OP_ASSIGN, op[1].slice(), clonePayload(op[2])];
  }
  if (code === OP_STRING_SPLICE) {
    return [OP_STRING_SPLICE, op[1].slice(), op[2], op[3], op[4]];
  }
  if (code === OP_ARRAY_SPLICE) {
    return [OP_ARRAY_SPLICE, op[1].slice(), op[2], op[3], clonePayload(op[4])];
  }
  if (code === OP_ARRAY_TWO_FIELD_INSERT) {
    return [OP_ARRAY_TWO_FIELD_INSERT, op[1].slice(), op[2], op[3], op[4], op[5].slice(), op[6].slice()];
  }
  if (code === OP_ARRAY_MOVE) {
    return [OP_ARRAY_MOVE, op[1].slice(), op[2], op[3]];
  }
  if (code === OP_STRING_COPY) {
    return [OP_STRING_COPY, op[1].slice(), op[2], op[3], op[4]];
  }
  if (code === OP_ARRAY_ASSIGN) {
    return [OP_ARRAY_ASSIGN, op[1].slice(), op[2].slice(), clonePayload(op[3])];
  }
  if (code === OP_ARRAY_OBJECT_ASSIGN) {
    return [OP_ARRAY_OBJECT_ASSIGN, op[1].slice(), op[2].slice(), clonePayload(op[3])];
  }
  if (code === OP_ARRAY_TUPLE_ASSIGN) {
    return [OP_ARRAY_TUPLE_ASSIGN, op[1].slice(), op[2].slice(), op[3].slice(), clonePayload(op[4])];
  }
  if (code === OP_ARRAY_OBJECT_FIELD_ASSIGN) {
    return [OP_ARRAY_OBJECT_FIELD_ASSIGN, op[1].slice(), op[2].slice(), copyFieldPaths(op[3]), clonePayload(op[4])];
  }
  return op.slice();
}

function compactPlannedArrayObjectSetRuns(patch) {
  const length = patch.length;
  if (length < 4) return;

  let out = null;
  let write = 0;
  let index = 0;
  while (index < length) {
    const first = readArrayObjectSetCandidate(patch[index]);
    if (first === null) {
      if (out !== null) out[write] = patch[index];
      write++;
      index++;
      continue;
    }

    let end = index + 1;
    let previousRow = first.row;
    while (end < length) {
      const next = readMatchingArrayObjectSetCandidate(patch[end], first);
      if (
        next === null ||
        next.row <= previousRow
      ) {
        break;
      }
      previousRow = next.row;
      end++;
    }

    const count = end - index;
    if (count >= 4) {
      if (out === null) out = patch.slice(0, write);
      const rowIndexes = new Array(count);
      const values = new Array(count);
      for (let i = 0; i < count; i++) {
        const op = patch[index + i];
        rowIndexes[i] = op[1][first.rowOffset];
        values[i] = op[2];
      }
      out[write++] = [OP_ARRAY_OBJECT_FIELD_ASSIGN, first.base, rowIndexes, [first.field], values];
    } else {
      if (out !== null) {
        for (let i = index; i < end; i++) out[write++] = patch[i];
      } else {
        write += count;
      }
    }

    index = end;
  }

  if (out !== null) {
    patch.length = write;
    for (let i = 0; i < write; i++) patch[i] = out[i];
  }
}

function readMatchingArrayObjectSetCandidate(op, first) {
  if (op[0] !== OP_SET) return null;
  const path = op[1];
  const base = first.base;
  const field = first.field;
  const rowOffset = first.rowOffset;
  if (path.length !== base.length + field.length + 1) return null;
  for (let i = 0; i < rowOffset; i++) {
    if (path[i] !== base[i]) return null;
  }
  for (let i = 0, length = field.length; i < length; i++) {
    if (path[rowOffset + 1 + i] !== field[i]) return null;
  }

  const row = path[rowOffset];
  return Number.isSafeInteger(row) && row >= 0 && !Object.is(row, -0)
    ? { row }
    : null;
}

function readArrayObjectSetCandidate(op) {
  if (op[0] !== OP_SET) return null;
  const path = op[1];
  if (path.length < 3) return null;
  for (let i = path.length - 2; i >= 1; i--) {
    const row = path[i];
    if (Number.isSafeInteger(row) && row >= 0 && !Object.is(row, -0)) {
      return {
        base: path.slice(0, i),
        row,
        rowOffset: i,
        field: path.slice(i + 1)
      };
    }
  }
  return null;
}

function copyFieldPaths(fields) {
  const out = new Array(fields.length);
  for (let i = 0, length = fields.length; i < length; i++) out[i] = fields[i].slice();
  return out;
}

function clonePayload(value) {
  return value !== null && typeof value === 'object' ? cloneJson(value) : value;
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}
