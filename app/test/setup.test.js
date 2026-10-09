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
