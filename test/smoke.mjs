import assert from 'node:assert';
import { applyPatchImmutable } from '@shapeshift-labs/frontier';
import {
  createDiffEngine,
  createEngineProfilePlansSnapshot,
  mergeProfilePlans
} from '../dist/index.js';
import { createDiffEngine as createDiffEngineSubpath } from '../dist/engine.js';
import { mergeProfilePlans as mergeProfilePlansSubpath } from '../dist/profile.js';

assert.strictEqual(createDiffEngineSubpath, createDiffEngine);
assert.strictEqual(mergeProfilePlansSubpath, mergeProfilePlans);

const engine = createDiffEngine({
  schema: {
    type: 'array',
    key: 'id',
    item: { type: 'object', key: 'id', fields: ['id', 'done', 'title'] }
  }
});
const before = [{ id: 'a', done: false, title: 'Draft' }];
const after = [{ id: 'a', done: true, title: 'Draft' }];
const patch = engine.diff(before, after);
assert.ok(patch.length > 0);
assert.deepStrictEqual(applyPatchImmutable(before, patch), after);

const profile = engine.getProfile();
assert.ok(profile && typeof profile === 'object');

const plans = createEngineProfilePlansSnapshot(undefined, {
  schemaCount: 1,
  adaptivePlan: false
});
assert.deepStrictEqual(mergeProfilePlans(plans), plans);

const history = engine.diffHistory({ value: 'a' }, [{ value: 'ab' }, { value: 'abc' }]);
assert.strictEqual(history.length, 2);
assert.deepStrictEqual(engine.applyHistory({ value: 'a' }, history), { value: 'abc' });
assert.deepStrictEqual(engine.applyEncodedHistory({ value: 'a' }, engine.encodeHistory(history)), { value: 'abc' });

assert.strictEqual(engine.createCrdtDocument, undefined);
assert.strictEqual(engine.createStateEngine, undefined);
