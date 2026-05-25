import assert from 'node:assert';
import { applyPatchImmutable, cloneJson, equalsJson } from '@shapeshift-labs/frontier';
import {
  cloneProfilePlans,
  createDiffEngine,
  createEngineProfilePlansSnapshot,
  mergeProfilePlans
} from '../dist/index.js';

const args = parseArgs(process.argv.slice(2));
const cases = readPositiveInt(args.cases, 400);
let seed = readUint(args.seed, 0x3e67696e);
const initialSeed = seed;

for (let id = 0; id < cases; id++) runCase(id);

console.log(`frontier engine fuzz passed cases=${cases} seed=${initialSeed}`);

function runCase(id) {
  if ((id & 1) === 0) runRecordArrayCase(id);
  else runObjectCase(id);
  checkProfilePlans(id);
}

function runRecordArrayCase(id) {
  const before = {
    rows: makeRows(12 + randomInt(12), id),
    meta: { version: id, label: 'case-' + id }
  };
  const after = cloneJson(before);
  const edits = 1 + randomInt(Math.max(1, after.rows.length >> 1));
  for (let i = 0; i < edits; i++) {
    const row = after.rows[randomInt(after.rows.length)];
    row.score += randomInt(15) - 5;
    if (randomBool()) row.active = !row.active;
    if (randomBool()) row.label += '-x' + randomInt(9);
  }
  if (randomBool() && after.rows.length > 2) after.rows.splice(randomInt(after.rows.length), 1);
  if (randomBool()) {
    after.rows.splice(randomInt(after.rows.length + 1), 0, {
      id: `new-${id}-${randomInt(1000)}`,
      score: randomInt(100),
      active: randomBool(),
      label: 'new'
    });
  }
  after.meta.version++;

  const schema = {
    type: 'array',
    path: ['rows'],
    key: 'id',
    item: { type: 'object', fields: ['id', 'score', 'active', 'label'] }
  };
  assertEngineRoundTrip(before, after, { schema, arrayKey: 'id' });

  const training = createDiffEngine({ adaptive: true, adaptiveThreshold: 1 });
  const profile = training.train([[before, after]]);
  assertEngineRoundTrip(before, after, { profile });
}

function runObjectCase(id) {
  const before = makeWideObject(id);
  const after = cloneJson(before);
  const keys = Object.keys(after);
  const edits = 1 + randomInt(8);
  for (let i = 0; i < edits; i++) {
    const key = keys[randomInt(keys.length)];
    const value = after[key];
    if (typeof value === 'number') after[key] = value + randomInt(11) - 5;
    else if (typeof value === 'string') after[key] = value + '-x' + randomInt(10);
    else if (typeof value === 'boolean') after[key] = !value;
    else if (value && typeof value === 'object') value.count += 1;
  }

  const schema = { type: 'object', fields: keys };
  assertEngineRoundTrip(before, after, { schema });

  const adaptive = createDiffEngine({ adaptive: true, adaptiveThreshold: 1 });
  adaptive.diff(before, after);
  assertEngineRoundTrip(before, after, { profile: adaptive.getProfile() });
}

function assertEngineRoundTrip(before, after, options) {
  const engine = createDiffEngine(options);
  const patch = engine.diff(before, after);
  assert.ok(equalsJson(applyPatchImmutable(before, patch), after));

  const out = [];
  assert.strictEqual(engine.diffInto(before, after, out), out);
  assert.ok(equalsJson(applyPatchImmutable(before, out), after));

  assert.strictEqual(engine.equals(after, after), true);
  assert.strictEqual(engine.equals(before, after), equalsJson(before, after));

  const middle = applyPatchImmutable(before, patch);
  const final = mutateFinal(after);
  const history = engine.diffHistory(before, [middle, final]);
  assert.ok(equalsJson(engine.applyHistory(before, history), final));
  assert.ok(equalsJson(engine.applyEncodedHistory(before, engine.encodeHistory(history)), final));
  assert.deepStrictEqual(engine.decodeHistory(engine.encodeHistory(history)), history);
}

function checkProfilePlans(id) {
  const plans = createEngineProfilePlansSnapshot(undefined, {
    schemaCount: 1 + (id % 3),
    adaptivePlan: (id & 1) === 1,
    schemaPaths: [['rows'], ['meta']],
    historyStrategy: randomBool() ? 'string-append' : 'auto'
  });
  const merged = mergeProfilePlans(plans, { codec: { patch: 'binary' } });
  assert.deepStrictEqual(cloneProfilePlans(merged), merged);
}

function mutateFinal(value) {
  const out = cloneJson(value);
  if (Array.isArray(out.rows)) {
    out.meta = { ...(out.meta || {}), version: Number(out.meta?.version || 0) + 1 };
    if (out.rows.length !== 0) out.rows[0] = { ...out.rows[0], score: Number(out.rows[0].score || 0) + 1 };
  } else {
    out.final = 'done-' + randomInt(100);
  }
  return out;
}

function makeRows(count, id) {
  const rows = new Array(count);
  for (let i = 0; i < count; i++) {
    rows[i] = {
      id: `r-${id}-${i}`,
      score: randomInt(200) - 50,
      active: randomBool(),
      label: 'row-' + i
    };
  }
  return rows;
}

function makeWideObject(id) {
  const out = {};
  for (let i = 0; i < 36; i++) {
    const kind = i % 4;
    out['field' + i] = kind === 0
      ? id + i
      : kind === 1
        ? 'value-' + id + '-' + i
        : kind === 2
          ? randomBool()
          : { count: randomInt(10), label: 'nested-' + i };
  }
  return out;
}

function randomBool() {
  return (nextRandom() & 1) === 1;
}

function randomInt(max) {
  return max <= 1 ? 0 : nextRandom() % max;
}

function nextRandom() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cases') out.cases = argv[++i];
    else if (arg === '--seed') out.seed = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node test/fuzz.mjs [--cases 400] [--seed 1046968686]');
      process.exit(0);
    } else {
      throw new Error('unknown argument: ' + arg);
    }
  }
  return out;
}

function readPositiveInt(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error('expected positive integer, got ' + value);
  return number;
}

function readUint(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error('expected integer seed, got ' + value);
  return number >>> 0;
}
