import type {
  DiffOptions,
  JsonPath,
  JsonValue,
  ObjectKey,
  Patch
} from '@shapeshift-labs/frontier/types';
import type {
  PatchHistoryBuilder,
  PatchHistoryCodecOptions
} from '@shapeshift-labs/frontier-codec';

export interface ProfilePlans {
  diff?: DiffProfilePlan;
  equality?: EqualityProfilePlan;
  history?: HistoryProfilePlan;
  codec?: CodecProfilePlan;
  state?: StateProfilePlan;
  crdt?: CrdtProfilePlan;
}

export interface DiffProfilePlan {
  strategy?: 'structural' | 'schema' | 'adaptive-schema';
  schemaCount?: number;
  paths?: JsonPath[];
}

export interface EqualityProfilePlan {
  strategy?: 'fast-json' | 'schema' | 'token';
  token?: 'versionKey' | 'fingerprintKey';
  key?: ObjectKey;
}

export interface HistoryProfilePlan {
  strategy?: 'auto' | 'string-append' | 'row-object-assign' | 'object-assign' | 'scalar-object';
}

export interface CodecProfilePlan {
  patch?: 'auto' | 'json' | 'binary';
  history?: 'auto' | 'binary' | 'binary-columnar';
  crdt?: 'auto' | 'json' | 'binary' | 'columnar-text';
}

export interface StateProfilePlan {
  routing?: 'patch-router';
  apply?: 'owned-mutable' | 'immutable';
  watches?: number;
  exactWatches?: number;
  wildcardWatches?: number;
  fieldWatches?: number;
  rangeWatches?: number;
}

export interface CrdtProfilePlan {
  update?: 'auto' | 'json' | 'binary' | 'columnar-text';
  text?: 'chunked-ids' | 'native-piece';
}

export type SchemaField = ObjectKey | NestedObjectSchemaField;

export interface NestedObjectSchemaField {
  key: ObjectKey;
  type: 'object';
  fields: SchemaField[];
}

export interface ObjectSchema {
  type: 'object';
  path?: JsonPath;
  fields: SchemaField[];
}

export interface RecordArraySchema {
  type: 'array';
  path?: JsonPath;
  key?: ObjectKey;
  item: {
    type: 'object';
    key?: ObjectKey;
    fields: SchemaField[];
  };
}

export type SingleSchema = ObjectSchema | RecordArraySchema;

export interface MultiSchema {
  schemas: SingleSchema[];
}

export type Schema = SingleSchema | MultiSchema;

export interface DiffProfile {
  version?: 1;
  settings?: EngineProfileSettings;
  plans?: ProfilePlans;
  schema?: SingleSchema;
  schemas?: SingleSchema[];
}

export interface EngineProfileSettings {
  cacheSize?: number;
  adaptive?: boolean;
  adaptiveThreshold?: number;
  arrayKey?: ObjectKey | false | null;
  autoArrayKey?: boolean;
  recordKeyCandidates?: ObjectKey[] | false | null;
  containerKeys?: ObjectKey[] | false | null;
  stable?: boolean;
  sortKeys?: boolean;
  maxPatchOperations?: number | null;
  versionKey?: ObjectKey;
  fingerprintKey?: ObjectKey;
}

export interface EngineOptions<TValue extends JsonValue = JsonValue> extends DiffOptions<TValue> {
  cacheSize?: number;
  maxEntries?: number;
  adaptive?: boolean;
  adaptiveThreshold?: number;
  schema?: Schema | null;
  containerKeys?: ObjectKey[] | false | null;
  profile?: DiffProfile | null;
}

export type TrainingSample<TSource extends JsonValue = JsonValue, TTarget extends JsonValue = JsonValue> =
  | [TSource, TTarget]
  | { source: TSource; target: TTarget }
  | { before: TSource; after: TTarget };

export interface DiffEngine {
  diff<TSource extends JsonValue, TTarget extends JsonValue>(
    source: TSource,
    target: TTarget,
    options?: DiffOptions<TSource | TTarget>
  ): Patch;

  diffInto<TSource extends JsonValue, TTarget extends JsonValue>(
    source: TSource,
    target: TTarget,
    patch: Patch,
    options?: DiffOptions<TSource | TTarget>
  ): Patch;

  equals<TSource extends JsonValue, TTarget extends JsonValue>(
    source: TSource,
    target: TTarget,
    options?: DiffOptions<TSource | TTarget>
  ): boolean;

  diffHistory<TSource extends JsonValue, TTarget extends JsonValue>(
    initial: TSource,
    states: TTarget[],
    options?: DiffOptions<TSource | TTarget>
  ): Patch[];

  encodeHistory(patches: Patch[], options?: PatchHistoryCodecOptions): Uint8Array;
  decodeHistory(bytes: ArrayBuffer | ArrayBufferView, options?: PatchHistoryCodecOptions): Patch[];
  applyHistory(source: JsonValue, patches: Patch[], options?: PatchHistoryCodecOptions): JsonValue;
  applyEncodedHistory(source: JsonValue, bytes: ArrayBuffer | ArrayBufferView, options?: PatchHistoryCodecOptions): JsonValue;
  createHistoryBuilder(): PatchHistoryBuilder;
  clear(): void;
  train(samples: TrainingSample[]): DiffProfile;
  getProfile(): DiffProfile;
  loadProfile(profile?: DiffProfile | null): void;
}
