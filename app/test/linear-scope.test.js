// node --test: Linear rescope guards (7A, OV10) with a stand-in walk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../lib/linear-scope');

function vault(cfg = 'sources:\n  linear:\n    scope: { initiative: "root-1" }\n', prev) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ls-'));
  fs.mkdirSync(path.join(v, 'linear'), { recursive: true });
  fs.mkdirSync(path.join(v, '.bot', 'state'), { recursive: true });
  fs.writeFileSync(path.join(v, 'config.yaml'), cfg);
  if (prev) fs.writeFileSync(path.join(v, 'linear', '.initiative-scope.json'), JSON.stringify(prev));
  return v;
}
const projs = (n) => Array.from({ length: n }, (_, i) => ({ id: `P-${i}`, name: `p${i}`, workstreams: ['W'] }));
const walkOf = ({ n = 10, unfinished = [], onlyUnion = [], onlyWalk = [], team } = {}) => async () => ({
  scope: team ? { team, root_id: null, initiatives: [], projects: projs(n), project_count: n } : { root_id: 'root-1', initiatives: [{ id: 'root-1', name: 'Root', parent_id: null, depth: 0 }], projects: projs(n), project_count: n },
  cross: team ? null : { walked: n, union: n - onlyWalk.length + onlyUnion.length, directKnown: true, onlyUnion, onlyWalk },
  unfinished, cost: 0.01,
});
async function rescope(v, body, w) {
  let done; const log = [];
  await L.runRescope({}, { vault: v, logLine: (_, s) => log.push(s), finish: (_, status, summary, detail) => { done = { status, summary, detail }; } }, body, w);
  return done;
}
const scopeOf = (v) => JSON.parse(fs.readFileSync(path.join(v, 'linear', '.initiative-scope.json'), 'utf8'));

test('the first scope is staged for the owner, then written on accept', async () => {
  const v = vault();
  const r = await rescope(v, {}, walkOf({ n: 12 }));
  assert.equal(r.status, 'warn');
  assert.match(r.summary, /first scope staged: walked 12/);
  assert.ok(!fs.existsSync(path.join(v, 'linear', '.initiative-scope.json')));
  assert.ok(L.staged(v) && !L.staged(v).blocked);
  const a = await rescope(v, { accept: true });
  assert.equal(a.status, 'ok');
  assert.equal(scopeOf(v).project_count, 12);
  assert.equal(L.staged(v), null);
});

test('a later rescope that passes the guard is written without asking', async () => {
  const v = vault(undefined, { root_id: 'root-1', project_count: 10, projects: projs(10), initiatives: [] });
  const r = await rescope(v, {}, walkOf({ n: 11, onlyWalk: [{ id: 'P-10', name: 'p10' }] }));
  assert.equal(r.status, 'ok');
  assert.equal(scopeOf(v).project_count, 11);
});

test('fewer than 80% of the last good scope is refused; the old scope stays', async () => {
  const v = vault(undefined, { root_id: 'root-1', project_count: 200, projects: projs(200), initiatives: [] });
  const r = await rescope(v, {}, walkOf({ n: 50 }));
  assert.equal(r.status, 'error');
  assert.match(r.summary, /under 80% of the last good scope \(200\)/);
  assert.equal(scopeOf(v).project_count, 200);
  assert.ok(L.staged(v).blocked);
});

test('pages not exhausted, or a project the walk missed, blocks', async () => {
  const prev = { root_id: 'root-1', project_count: 10, projects: projs(10), initiatives: [] };
  let v = vault(undefined, prev);
  assert.match((await rescope(v, {}, walkOf({ unfinished: ['list_projects x'] }))).summary, /never finished/);
  v = vault(undefined, prev);
  const r = await rescope(v, {}, walkOf({ onlyUnion: [{ id: 'P-99', name: 'missed', from: 'W' }] }));
  assert.match(r.summary, /the two counts disagree/);
  assert.equal(scopeOf(v).project_count, 10);
  // accept cannot take a blocked staging
  assert.equal((await rescope(v, { accept: true })).status, 'error');
});

test('a team scope comes from config and has no cross-check', async () => {
  const v = vault('sources:\n  linear:\n    scope: { team: "ENG" }\n', { team: 'ENG', project_count: 5, projects: projs(5), initiatives: [] });
  assert.deepEqual(L.scopeTarget(v), { team: 'ENG' });
  const r = await rescope(v, {}, walkOf({ n: 6, team: 'ENG' }));
  assert.equal(r.status, 'ok');
  assert.equal(scopeOf(v).team, 'ENG');
});

test('no config and no cache = a clear error', async () => {
  const v = vault('owner:\n  name: x\n');
  assert.match((await rescope(v, {}, walkOf())).summary, /set sources\.linear\.scope/);
});
