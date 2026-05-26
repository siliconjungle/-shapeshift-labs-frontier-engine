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

{
  const schema = { type: 'object', fields: ['x', 'label'] };
  const exactEngine = createDiffEngine({ schema });
  assert.notDeepStrictEqual(
    exactEngine.diff({ x: 1.04, label: 'a' }, { x: 1.049, label: 'a' }),
    []
  );

  const quantizedEngine = createDiffEngine({
    schema,
    quantization: [{ path: ['x'], step: 0.1, fixedStep: true }]
  });
  assert.deepStrictEqual(
    quantizedEngine.diff({ x: 1.04, label: 'a' }, { x: 1.049, label: 'a' }),
    []
  );
  const quantizedPatch = quantizedEngine.diff({ x: 1.04, label: 'a' }, { x: 1.16, label: 'a' });
  assert.deepStrictEqual(quantizedPatch, [[0, ['x'], 1.2]]);
  assert.deepStrictEqual(applyPatchImmutable({ x: 1.04, label: 'a' }, quantizedPatch), { x: 1.2, label: 'a' });
  assert.strictEqual(quantizedEngine.equals({ x: 1.04, label: 'a' }, { x: 1.049, label: 'a' }), true);
  assert.strictEqual(quantizedEngine.getProfile().settings.quantization[0].step, 0.1);
  assert.strictEqual(quantizedEngine.getProfile().plans.determinism.numeric, 'quantized');
}

{
  const rowEngine = createDiffEngine({
    schema: {
      type: 'array',
      path: ['rows'],
      key: 'id',
      item: { type: 'object', key: 'id', fields: ['id', 'x'] }
    },
    quantization: [{ path: ['rows', '*', 'x'], step: 0.25 }]
  });
  assert.deepStrictEqual(
    rowEngine.diff({ rows: [{ id: 'a', x: 1.01 }] }, { rows: [{ id: 'a', x: 1.11 }] }),
    []
  );
  assert.deepStrictEqual(
    rowEngine.diff({ rows: [{ id: 'a', x: 1.01 }] }, { rows: [{ id: 'a', x: 1.2 }] }),
    [[0, ['rows', 0, 'x'], 1.25]]
  );
}

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
