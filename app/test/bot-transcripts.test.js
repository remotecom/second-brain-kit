const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../lib/bot-transcripts');
const { transcriptDirs } = require('../lib/session-raw');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-home-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-vault-'));
  const dir = transcriptDirs(vault, home).pop();
  fs.mkdirSync(dir, { recursive: true });
  const write = (id, entrypoint, prompt, ageDays = 0) => {
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, [
      JSON.stringify({ type: 'queue-operation' }),
      JSON.stringify({ type: 'user', entrypoint, message: { role: 'user', content: prompt } }),
      '',
    ].join('\n'));
    const t = new Date(Date.now() - ageDays * 86400000);
    fs.utimesSync(f, t, t);
    return f;
  };
  return { home, vault, dir, write };
}

const ID = (n) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;

test('remove deletes a passed part transcript and its spill folder, nothing else', () => {
  const { home, vault, dir, write } = setup();
  const ing = write(ID(1), 'sdk-cli', `${B.MARK} This is part 1 of 2\n${'x'.repeat(200000)}`); // real prompts are ~70 KB
  fs.mkdirSync(path.join(dir, ID(1), 'tool-results'), { recursive: true });
  const own = write(ID(2), 'cli', `${B.MARK} pasted by the owner`);
  const other = write(ID(3), 'sdk-cli', 'List the Linear initiatives I own');
  assert.strictEqual(B.remove(vault, [ID(1), ID(2), ID(3), '../etc', 'x'], { home }), 1);
  assert.ok(!fs.existsSync(ing));
  assert.ok(!fs.existsSync(path.join(dir, ID(1))));
  assert.ok(fs.existsSync(own), 'an interactive session is never deleted');
  assert.ok(fs.existsSync(other), 'another -p run is never deleted');
});

test('sweep deletes only ingest transcripts older than the keep window', () => {
  const { home, vault, write } = setup();
  const old = write(ID(4), 'sdk-cli', `${B.MARK} part 3 of 3`, B.KEEP_FAILED_DAYS + 1);
  const recent = write(ID(5), 'sdk-cli', `${B.MARK} part 1 of 1`, 1);
  const ownOld = write(ID(6), 'cli', 'hello', 400);
  const r = B.sweep(vault, { home });
  assert.strictEqual(r.deleted, 1);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(recent), 'a recent failed part stays, to see what went wrong');
  assert.ok(fs.existsSync(ownOld));
});

test('sweep on a vault with no transcript folder is a no-op', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-home-'));
  assert.deepStrictEqual(B.sweep('/nonexistent/vault', { home }), { deleted: 0, bytes: 0 });
});
