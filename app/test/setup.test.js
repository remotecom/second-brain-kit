// node --test: `second-brain setup` end to end, in a temp HOME with a fake
// claude. No launchctl (SECOND_BRAIN_NO_LAUNCHCTL), no network, no model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('../lib/vendor/js-yaml');
const { FLAGS } = require('../lib/doctor');

const CLI = path.join(__dirname, '..', 'cli.js');

function fakeHome({ loggedIn = true, method = 'claude.ai' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-home-'));
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
case "$1" in
  --version) echo "2.1.296 (Claude Code)";;
  auth) echo '{"loggedIn": ${loggedIn}, "authMethod": "${method}", "email": "sam@example.com"}';;
  *) printf '%s\\n' ${FLAGS.map((f) => `"  ${f} <x>"`).join(' ')};;
esac
`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  return home;
}

function run(home, args) {
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, SECOND_BRAIN_NO_LAUNCHCTL: '1' };
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60000 });
}

test('setup creates a working vault, settings and a login item', () => {
  const home = fakeHome();
  const vault = path.join(home, 'Brain');
  const r = run(home, ['setup', '--vault', vault, '--yes', '--name', 'Sam Rivera', '--slack-user-id', 'U0SAMPLE1', '--timezone', 'America/New_York']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // vault
  for (const p of ['wiki/index.md', 'wiki/log.md', 'slack', 'gcal', 'linear/issues', 'notion/pages', 'gdrive/files', 'projects', '.bot', '.gitignore', 'config.yaml', 'CLAUDE.md']) assert.ok(fs.existsSync(path.join(vault, p)), p);
  const cfg = yaml.load(fs.readFileSync(path.join(vault, 'config.yaml'), 'utf8'));
  assert.equal(cfg.owner.name, 'Sam Rivera');
  assert.equal(cfg.owner.email, 'sam@example.com'); // from the claude.ai login
  assert.equal(cfg.owner.slack_user_id, 'U0SAMPLE1');
  assert.equal(cfg.owner.timezone, 'America/New_York');
  assert.deepEqual(cfg.sources.gcal.calendars, ['sam@example.com']);
  assert.match(fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8'), /^<!-- kit:begin v1 sha=/);
  // settings + login item
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.second-brain', 'settings.json'), 'utf8'));
  assert.equal(settings.vault, vault);
  const plist = fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', 'dev.secondbrain.app.plist'), 'utf8');
  assert.match(plist, /<string>dev\.secondbrain\.app<\/string>/);
  assert.ok(plist.includes(`<string>${fs.realpathSync(process.execPath)}</string>`), 'absolute node path');
  assert.ok(plist.includes(`<string>${vault}</string>`));
  assert.ok(!/\{\{/.test(plist));
  // the Dock app (the Dock itself is skipped in test mode)
  assert.ok(fs.existsSync(path.join(home, 'Applications', 'Second Brain.app', 'Contents', 'MacOS', 'second-brain')), 'Dock app');
  assert.match(r.stdout, /✓ app: .*Second Brain\.app \(Dock skipped: test mode\)/);
  // transcripts kept, memories bound (none in a new HOME)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).cleanupPeriodDays, 36500);
  assert.match(r.stdout, /✓ project memories: nothing to bind/);
  assert.match(r.stdout, /Next: open http:\/\/localhost:19300/);
});

test('running setup again changes nothing that exists', () => {
  const home = fakeHome();
  const vault = path.join(home, 'Brain');
  run(home, ['setup', '--vault', vault, '--yes', '--name', 'Sam']);
  const cfgFile = path.join(vault, 'config.yaml');
  fs.appendFileSync(cfgFile, '# my edit\n');
  fs.appendFileSync(path.join(vault, 'CLAUDE.md'), '\nMY NOTES\n');
  const before = [fs.readFileSync(cfgFile, 'utf8'), fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8')];
  const r = run(home, ['setup', '--vault', vault, '--yes', '--name', 'Someone Else']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing was changed/);
  assert.deepEqual([fs.readFileSync(cfgFile, 'utf8'), fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8')], before);
});

test('setup refuses without a claude.ai login, and names the fix', () => {
  const r = run(fakeHome({ loggedIn: false }), ['setup', '--vault', '/tmp/x', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /not logged in/);
  const r2 = run(fakeHome({ method: 'api_key' }), ['setup', '--vault', '/tmp/x', '--yes']);
  assert.match(r2.stdout, /need a claude\.ai login/);
});

test('setup needs a vault path (no default) and refuses one inside the kit', () => {
  const home = fakeHome();
  assert.match(run(home, ['setup', '--yes']).stderr, /pass --vault/);
  assert.match(run(home, ['setup', '--yes', '--vault', path.join(__dirname, 'x')]).stderr, /inside the kit/);
});

test('the server without a vault serves the not-set-up page', async () => {
  const home = fakeHome();
  const port = 19400 + Math.floor(Math.random() * 500);
  const { spawn } = require('child_process');
  const s = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: '/usr/bin:/bin', HOME: home, SECOND_BRAIN_PORT: String(port) }, stdio: 'pipe' });
  try {
    await new Promise((res) => s.stdout.on('data', (d) => /Second Brain on/.test(d) && res()));
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /not set up yet/);
  } finally { s.kill(); }
});

// Make me better's Apply polls /alive: no token, no setup needed, and it
// must say whether the brain is up. /api/* still needs the token.
async function serve(home, extraEnv = {}) {
  const port = 19400 + Math.floor(Math.random() * 500);
  const { spawn } = require('child_process');
  const s = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: `${path.join(home, '.local', 'bin')}:/usr/bin:/bin`, HOME: home, SECOND_BRAIN_PORT: String(port), SECOND_BRAIN_NO_LAUNCHCTL: '1', ...extraEnv }, stdio: 'pipe' });
  await new Promise((res, rej) => { s.stdout.on('data', (d) => /Second Brain on/.test(d) && res()); s.on('exit', (c) => rej(new Error(`server exited ${c}`))); });
  return { s, base: `http://127.0.0.1:${port}` };
}

test('/alive answers without a token; /api/* still refuses without one', async () => {
  const home = fakeHome();
  const { s, base } = await serve(home);
  try {
    const a = await (await fetch(`${base}/alive`)).json();
    const head = spawnSync('/usr/bin/git', ['-C', path.join(__dirname, '..', '..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(a.ok, true);
    assert.equal(a.sha, head);
    assert.equal(a.brain, false, 'no vault: the brain never loaded');
    assert.ok(Date.parse(a.startedAt));
    assert.equal((await fetch(`${base}/api/runs`)).status, 401);
  } finally { s.kill(); }
});

test('/alive says brain:true once a vault loads; NO_SCHEDULE starts no bot', async () => {
  const home = fakeHome();
  const vault = path.join(home, 'Brain');
  assert.equal(run(home, ['setup', '--vault', vault, '--yes', '--name', 'Sam', '--no-login-item']).status, 0);
  const { s, base } = await serve(home, { SECOND_BRAIN_NO_SCHEDULE: '1' });
  try {
    const a = await (await fetch(`${base}/alive`)).json();
    assert.equal(a.brain, true);
    const b = await (await fetch(`${base}/alive`)).json();
    assert.equal(b.startedAt, a.startedAt, 'same process across polls');
  } finally { s.kill(); }
});

test('What\'s new answers through the API (the route filter lets it in)', async () => {
  const home = fakeHome();
  assert.equal(run(home, ['setup', '--vault', path.join(home, 'Brain'), '--yes', '--name', 'Sam', '--no-login-item']).status, 0);
  const { s, base } = await serve(home, { SECOND_BRAIN_NO_SCHEDULE: '1' });
  try {
    const token = fs.readFileSync(path.join(home, '.second-brain', 'token'), 'utf8').trim();
    const r = await fetch(`${base}/api/whatsnew`, { headers: { 'X-Brain-Token': token } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.items) || typeof j.error === 'string', JSON.stringify(j).slice(0, 200));
    assert.notEqual(j.error, 'not found');
  } finally { s.kill(); }
});

test('setup on an existing vault adds no skeleton files to it', () => {
  const home = fakeHome();
  const vault = path.join(home, 'Old');
  for (const d of ['wiki/partners', 'slack', 'projects/repo']) fs.mkdirSync(path.join(vault, d), { recursive: true });
  fs.writeFileSync(path.join(vault, 'wiki', 'index.md'), '# Index\n');
  const r = run(home, ['setup', '--vault', vault, '--yes', '--name', 'Sam', '--no-login-item']);
  assert.equal(r.status, 0, r.stderr);
  for (const p of ['wiki/README.md', 'projects/README.md', 'slack/README.md', 'wiki/partners/.gitkeep']) assert.ok(!fs.existsSync(path.join(vault, p)), p);
  assert.ok(fs.existsSync(path.join(vault, 'wiki', 'log.md')), 'what the bots need is still added');
});

test('a README.md in wiki/ or projects/ is not a page or a memory store', () => {
  const V = require('../lib/verify-bot');
  const home = fakeHome();
  const vault = path.join(home, 'Brain');
  run(home, ['setup', '--vault', vault, '--yes', '--name', 'Sam', '--no-login-item']);
  const w = V.wikiChecks(vault);
  assert.ok(!w.bad.some((b) => /README/.test(b)), w.bad.join('\n'));
  assert.ok(!w.unindexed.some((u) => /README/.test(u)));
  const lint = spawnSync('/bin/bash', [path.join(__dirname, '..', '..', 'scripts', 'linkrot-lint.sh'), '--vault', vault], { encoding: 'utf8' }).stdout;
  assert.ok(!/NOTADIR/.test(lint), lint.split('\n').filter((l) => /NOTADIR/.test(l)).join('\n'));
});

test('the CLI has status and run, and deliberately no answer command (OV-a)', () => {
  const home = fakeHome();
  const r = run(home, ['answer', 'n-1', 'A']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command "answer"/);
  const h = run(home, ['help']);
  assert.match(h.stdout, /second-brain status/);
  assert.match(h.stdout, /second-brain run <bot>/);
  assert.match(run(home, ['run']).stderr, /which bot/);
});

test('a side install (SECOND_BRAIN_STATE_DIR) never touches the Mac: no Dock app, no binding, no retention', () => {
  const home = fakeHome();
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, SECOND_BRAIN_NO_LAUNCHCTL: '1', SECOND_BRAIN_STATE_DIR: path.join(home, 'side-state') };
  const r = spawnSync(process.execPath, [CLI, 'setup', '--vault', path.join(home, 'Side'), '--yes', '--no-login-item'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /side install/);
  assert.ok(!fs.existsSync(path.join(home, 'Applications')), 'no Dock app');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'settings.json')), 'retention untouched');
  assert.ok(!/project memories/.test(r.stdout), 'no binding');
});
