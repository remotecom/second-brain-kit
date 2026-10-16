// node --test: `second-brain update` end to end with a local bare repo as the
// upstream (5A). A temp HOME; no launchctl.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('../lib/vendor/js-yaml');
const { FLAGS } = require('../lib/doctor');

const KIT = path.resolve(__dirname, '..', '..');
const sh = (cwd, ...a) => { const r = spawnSync('/usr/bin/git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-upd-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), `#!/bin/sh\ncase "$1" in --version) echo 2.1.296;; auth) echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "sam@example.com"}';; *) printf '%s\\n' ${FLAGS.map((f) => `"  ${f} <x>"`).join(' ')};; esac\n`);
  fs.chmodSync(path.join(home, '.local', 'bin', 'claude'), 0o755);
  const branch = sh(KIT, 'rev-parse', '--abbrev-ref', 'HEAD');
  const bare = path.join(root, 'origin.git');
  sh(root, 'clone', '-q', '--bare', '--branch', branch, KIT, bare);
  const live = path.join(root, 'live');
  sh(root, 'clone', '-q', '--branch', branch, bare, live);
  const work = path.join(root, 'work');
  sh(root, 'clone', '-q', '--branch', branch, bare, work);
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, SECOND_BRAIN_NO_LAUNCHCTL: '1' };
  const cli = (args) => spawnSync(process.execPath, [path.join(live, 'app', 'cli.js'), ...args], { env, encoding: 'utf8', timeout: 60000 });
  const vault = path.join(home, 'Brain');
  const s = cli(['setup', '--vault', vault, '--yes', '--name', 'Sam', '--no-login-item']);
  assert.equal(s.status, 0, s.stderr);
  return { root, live, work, vault, cli, branch };
}

test('update pulls new commits, adds new config keys and refreshes the kit block; owner text stays', { timeout: 120000 }, async () => {
  const w = world();
  // The owner's own edits.
  fs.appendFileSync(path.join(w.vault, 'CLAUDE.md'), '\nMY OWN NOTES\n');
  fs.writeFileSync(path.join(w.vault, 'config.yaml'), fs.readFileSync(path.join(w.vault, 'config.yaml'), 'utf8').replace('usage_share: normal', 'usage_share: heavy   # mine'));
  // Upstream: a new config key and a new line in the kit block.
  fs.appendFileSync(path.join(w.work, 'config.example.yaml'), '\n# A new key from upstream.\nnew_feature:\n  enabled: true\n');
  const tm = path.join(w.work, 'templates', 'vault', 'CLAUDE.md');
  fs.writeFileSync(tm, fs.readFileSync(tm, 'utf8').replace('## Layout\n', '## Layout\n\nUPSTREAM LINE.\n'));
  sh(w.work, 'commit', '-qam', 'upstream change');
  sh(w.work, 'push', '-q', 'origin', w.branch);

  const before = sh(w.live, 'rev-parse', 'HEAD');
  const r = w.cli(['update', '--yes']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 new commit\(s\)/);
  assert.notEqual(sh(w.live, 'rev-parse', 'HEAD'), before);
  const cfgText = fs.readFileSync(path.join(w.vault, 'config.yaml'), 'utf8');
  const cfg = yaml.load(cfgText);
  assert.equal(cfg.new_feature.enabled, true);
  assert.equal(cfg.usage_share, 'heavy');
  assert.match(cfgText, /usage_share: heavy   # mine/);
  const md = fs.readFileSync(path.join(w.vault, 'CLAUDE.md'), 'utf8');
  assert.match(md, /UPSTREAM LINE\./);
  assert.ok(md.endsWith('\nMY OWN NOTES\n'));
  // A second run: nothing to do.
  assert.match(w.cli(['update', '--yes']).stdout, /up to date/);
});

test('update refuses a kit checkout with local edits, and an edit inside the kit block stops only that part', { timeout: 120000 }, async () => {
  const w = world();
  fs.appendFileSync(path.join(w.live, 'README.md'), '\nlocal edit\n');
  const r = w.cli(['update', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /has local edits/);
  spawnSync('/usr/bin/git', ['-C', w.live, 'checkout', '--', 'README.md']);
  const f = path.join(w.vault, 'CLAUDE.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('## Layout\n', '## Layout\n\nEDITED INSIDE.\n'));
  const tm = path.join(w.work, 'templates', 'vault', 'CLAUDE.md');
  fs.writeFileSync(tm, fs.readFileSync(tm, 'utf8').replace('## Layout\n', '## Layout\n\nUPSTREAM LINE.\n'));
  sh(w.work, 'commit', '-qam', 'upstream change');
  sh(w.work, 'push', '-q', 'origin', w.branch);
  const r2 = w.cli(['update', '--yes']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /CLAUDE\.md: NOT updated/);
  assert.match(fs.readFileSync(f, 'utf8'), /EDITED INSIDE\./);
});

test('a copy with commits of its own is never pulled; update says so and changes nothing', { timeout: 120000 }, async () => {
  const w = world();
  sh(w.live, 'checkout', '-q', '-b', 'mine');
  sh(w.live, 'branch', `--set-upstream-to=origin/${w.branch}`, 'mine');
  fs.appendFileSync(path.join(w.live, 'README.md'), '\nmy change\n');
  sh(w.live, 'commit', '-qam', 'my change');
  fs.appendFileSync(path.join(w.work, 'README.md'), '\nupstream\n');
  sh(w.work, 'commit', '-qam', 'upstream change');
  sh(w.work, 'push', '-q', 'origin', w.branch);
  const before = sh(w.live, 'rev-parse', 'HEAD');
  const r = w.cli(['update', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 change\(s\) of its own, so update does not pull/);
  assert.match(r.stdout, /upstream change/);
  assert.equal(sh(w.live, 'rev-parse', 'HEAD'), before);
});

test('update refuses while another change to the kit holds the lock', { timeout: 120000 }, async () => {
  const w = world();
  const state = path.join(w.root, 'home', '.second-brain');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'apply.lock'), JSON.stringify({ pid: process.pid, what: 'apply' }));
  const r = w.cli(['update', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /being changed \(apply\)/);
});
