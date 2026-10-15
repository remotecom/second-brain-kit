// node --test: "Save & close" (lib/session-raw.js) and the Mac-wide helpers
// (lib/retention.js), in a temp HOME. Raw is the transcript's text, word for
// word, one file per day; nothing the owner did not save is copied.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/session-raw');
const retention = require('../lib/retention');

const SID = '0f1e2d3c-aaaa-bbbb-cccc-000000000001';
const PROMPT = 'You are in a Second Brain app session. Context: the app prompt.';

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-raw-'));
  const vault = path.join(home, 'vault');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'config.yaml'), 'owner:\n  timezone: UTC\n');
  const dir = path.join(home, '.claude', 'projects', fs.realpathSync(vault).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const line = (o) => JSON.stringify({ sessionId: SID, entrypoint: 'cli', ...o });
  const lines = [
    line({ type: 'user', timestamp: '2026-10-14T23:50:00Z', message: { role: 'user', content: PROMPT } }),
    line({ type: 'user', timestamp: '2026-10-14T23:51:00Z', message: { role: 'user', content: 'We decided the sandbox token is sk-abcdefghijklmnopqrstuvwx and launch moves to Nov 3.' } }),
    line({ type: 'assistant', timestamp: '2026-10-14T23:52:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted: launch on Nov 3.' }, { type: 'tool_use', name: 'Grep', input: {} }] } }),
    line({ type: 'user', timestamp: '2026-10-14T23:52:05Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOL OUTPUT' }] } }),
    line({ type: 'user', timestamp: '2026-10-14T23:53:00Z', isMeta: true, message: { role: 'user', content: 'META' } }),
    line({ type: 'user', timestamp: '2026-10-14T23:54:00Z', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    line({ type: 'assistant', timestamp: '2026-10-14T23:55:00Z', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'SUBAGENT' }] } }),
    line({ type: 'user', timestamp: '2026-10-15T00:10:00Z', message: { role: 'user', content: 'Next day: owner is Sam.' } }),
  ];
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), `${lines.join('\n')}\n`);
  return { home, vault, file: path.join(dir, `${SID}.jsonl`) };
}

test('Save writes one verbatim file per day, without tools, meta, sub-agents or the app prompt', () => {
  const w = world();
  const r = R.saveSession(w.vault, { sessionId: SID, title: 'Launch chat', kind: 'chat', prompt: PROMPT }, { home: w.home });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.written, ['projects/sessions/2026-10-14-0f1e2d3c.md', 'projects/sessions/2026-10-15-0f1e2d3c.md']);
  assert.equal(r.secrets, 1);
  const d1 = fs.readFileSync(path.join(w.vault, r.written[0]), 'utf8');
  assert.match(d1, /^---\nname: "Launch chat \(2026-10-14\)"\ntype: session\nsession_id: 0f1e2d3c/);
  assert.match(d1, /### .* · You\n\nWe decided the sandbox token is \[credential redacted by sync\] and launch moves to Nov 3\./);
  assert.match(d1, /### .* · Claude\n\nNoted: launch on Nov 3\./);
  for (const gone of ['app prompt', 'TOOL OUTPUT', 'META', '/clear', 'SUBAGENT', 'sk-abc']) assert.ok(!d1.includes(gone), gone);
  assert.match(fs.readFileSync(path.join(w.vault, r.written[1]), 'utf8'), /Next day: owner is Sam\./);
});

test('Saving again changes nothing; a rename does not rewrite raw', () => {
  const w = world();
  const s = { sessionId: SID, title: 'Launch chat', kind: 'chat', prompt: PROMPT };
  R.saveSession(w.vault, s, { home: w.home });
  const again = R.saveSession(w.vault, { ...s, title: 'Renamed later' }, { home: w.home });
  assert.deepEqual(again.written, []);
  assert.equal(again.unchanged, 2);
  // New turns on a day: only that day's file is rewritten, with its first title.
  fs.appendFileSync(w.file, `${JSON.stringify({ sessionId: SID, entrypoint: 'cli', type: 'user', timestamp: '2026-10-15T01:00:00Z', message: { role: 'user', content: 'One more thing.' } })}\n`);
  const more = R.saveSession(w.vault, { ...s, title: 'Renamed later' }, { home: w.home });
  assert.deepEqual(more.written, ['projects/sessions/2026-10-15-0f1e2d3c.md']);
  assert.match(fs.readFileSync(path.join(w.vault, more.written[0]), 'utf8'), /^title: "Launch chat"$/m);
});

test('Nothing the owner wrote, or no transcript: nothing is saved', () => {
  const w = world();
  assert.match(R.saveSession(w.vault, { sessionId: 'ffffffff-0000-0000-0000-000000000000', title: 'x' }, { home: w.home }).error, /no transcript/);
  fs.writeFileSync(w.file, `${JSON.stringify({ sessionId: SID, entrypoint: 'cli', type: 'user', timestamp: '2026-10-14T23:50:00Z', message: { role: 'user', content: PROMPT } })}\n`);
  assert.match(R.saveSession(w.vault, { sessionId: SID, title: 'x', prompt: PROMPT }, { home: w.home }).error, /nothing you wrote/);
  assert.ok(!fs.existsSync(path.join(w.vault, 'projects', 'sessions')));
});

test('retention: sets cleanupPeriodDays, keeps other keys, never overwrites a file it cannot read', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ret-'));
  assert.equal(retention.check(home).ok, false);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(retention.file(home), JSON.stringify({ model: 'opus', cleanupPeriodDays: 30 }));
  assert.equal(retention.ensure(home), 'set');
  assert.deepEqual(JSON.parse(fs.readFileSync(retention.file(home), 'utf8')), { model: 'opus', cleanupPeriodDays: retention.KEEP_DAYS });
  assert.equal(retention.ensure(home), 'already');
  fs.writeFileSync(retention.file(home), '{ broken');
  assert.throws(() => retention.ensure(home), /does not parse/);
  assert.equal(fs.readFileSync(retention.file(home), 'utf8'), '{ broken');
});
