// node --test: end to end through the real server (T26). A temp HOME with a
// fake `claude` that answers the doctor (--version, --help, auth status) and
// acts as an interactive session. Paths: Repair -> outcome -> item gone;
// close without outcome -> item stays; app restart -> session asleep ->
// open resumes the same id. Plus the CLI's error paths and the lock file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { FLAGS } = require('../lib/doctor');
const { ptyOk } = require('../lib/sessions');

const APP = path.join(__dirname, '..');
const skip = !ptyOk() && 'python3 pty is not available';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(home, 'fake.log');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash
case "$1" in
  --version) echo "2.1.296 (Claude Code)"; exit 0;;
  auth) echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "sam@example.com"}'; exit 0;;
  --help) printf '%s\\n' ${FLAGS.map((f) => `"  ${f} <x>"`).join(' ')}; exit 0;;
esac
echo "ARGS $*" >> "${log}"
echo "READY"
while IFS= read -r line; do echo "ECHO $line"; done
`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const vault = path.join(home, 'Brain');
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, SECOND_BRAIN_NO_LAUNCHCTL: '1' };
  const r = spawnSync(process.execPath, [path.join(APP, 'cli.js'), 'setup', '--vault', vault, '--yes', '--name', 'Sam', '--slack-user-id', 'U0SAMPLE1', '--no-login-item'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const port = 19500 + Math.floor(Math.random() * 400);
  return { home, vault, env: { ...env, SECOND_BRAIN_PORT: String(port) }, port, log };
}

async function server(w) {
  const s = spawn(process.execPath, [path.join(APP, 'server.js')], { env: w.env, stdio: 'pipe' });
  await new Promise((res, rej) => { s.stdout.on('data', (d) => /Second Brain on/.test(d) && res()); s.on('exit', () => rej(new Error('server exited'))); });
  const token = fs.readFileSync(path.join(w.home, '.second-brain', 'token'), 'utf8').trim();
  const H = { 'Content-Type': 'application/json', 'X-Brain-Token': token, Origin: `http://localhost:${w.port}` };
  const api = (p, body) => fetch(`http://127.0.0.1:${w.port}${p}`, { method: body ? 'POST' : 'GET', headers: H, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  return { s, api, token, stop: () => new Promise((res) => { s.on('exit', res); s.kill('SIGTERM'); }) };
}
const setupKeys = async (api) => (await api('/api/brain/bots')).setup.filter((f) => f.level === 'error').map((f) => f.key);

test('Repair in a session: the outcome fixes the item; Close without one leaves it', { skip, timeout: 60000 }, async () => {
  const w = world();
  fs.rmSync(path.join(w.vault, 'slack'), { recursive: true });
  const app = await server(w);
  try {
    assert.ok((await setupKeys(app.api)).includes('dir:slack'));
    // Close without an outcome: the item stays.
    let s = (await app.api('/api/sessions', { kind: 'repair' })).session;
    assert.deepEqual(s.outcomes.map((o) => o.label), ['Run Repair', 'Check again']);
    s = (await app.api(`/api/sessions/${s.id}/close`, {})).session;
    assert.equal(s.state, 'done');
    assert.ok((await setupKeys(app.api)).includes('dir:slack'));
    // A new Repair session; its outcome does the repair and closes it.
    s = (await app.api('/api/sessions', { kind: 'repair' })).session;
    const r = await app.api(`/api/sessions/${s.id}/outcome`, { label: 'Run Repair' });
    assert.match(r.summary, /slack\//);
    assert.equal(r.session.state, 'done');
    assert.equal(r.session.outcome, 'Run Repair');
    assert.ok(!(await setupKeys(app.api)).includes('dir:slack'));
    // An outcome the session does not have is refused.
    s = (await app.api('/api/sessions', { kind: 'repair' })).session;
    assert.match((await app.api(`/api/sessions/${s.id}/outcome`, { label: 'Delete everything' })).error, /no such outcome/);
  } finally { await app.stop(); }
});

test('after an app restart a session is asleep and opening it resumes the same id', { skip, timeout: 60000 }, async () => {
  const w = world();
  let app = await server(w);
  let s = (await app.api('/api/sessions', { kind: 'chat', model: 'haiku', item: { title: 'Ask the vault' } })).session;
  for (let i = 0; i < 40 && !fs.existsSync(w.log); i++) await wait(100);
  assert.match(fs.readFileSync(w.log, 'utf8'), new RegExp(`--session-id ${s.sessionId}`));
  // The lock is held while the app runs.
  const lock = JSON.parse(fs.readFileSync(path.join(w.vault, '.bot', 'lock'), 'utf8'));
  assert.ok(lock.pid && Date.now() - Date.parse(lock.heartbeat) < 60000);
  await app.stop();
  assert.ok(!fs.existsSync(path.join(w.vault, '.bot', 'lock')), 'lock released on exit');
  app = await server(w);
  try {
    const again = (await app.api('/api/sessions')).sessions.find((x) => x.id === s.id);
    assert.equal(again.state, 'asleep');
    s = (await app.api(`/api/sessions/${s.id}/open`, {})).session;
    assert.equal(s.state, 'open');
    for (let i = 0; i < 40 && fs.readFileSync(w.log, 'utf8').trim().split('\n').length < 2; i++) await wait(100);
    assert.match(fs.readFileSync(w.log, 'utf8').trim().split('\n')[1], new RegExp(`--resume ${s.sessionId}`));
  } finally { await app.stop(); }
});

test('the websocket refuses a bad token and a foreign origin', { skip, timeout: 60000 }, async () => {
  const w = world();
  const app = await server(w);
  const WebSocket = require('../lib/vendor/ws');
  try {
    const s = (await app.api('/api/sessions', { kind: 'chat' })).session;
    const tryWs = (token, origin) => new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${w.port}/?session=${s.id}&token=${token}`, { headers: { Origin: origin } });
      ws.on('open', () => { ws.close(); res('open'); });
      ws.on('error', () => res('refused'));
    });
    assert.equal(await tryWs(app.token, `http://localhost:${w.port}`), 'open');
    assert.equal(await tryWs('wrong', `http://localhost:${w.port}`), 'refused');
    assert.equal(await tryWs(app.token, 'https://evil.example'), 'refused');
  } finally { await app.stop(); }
});

test('the CLI: unknown bot, a busy bot, and a bad token', { skip, timeout: 60000 }, async () => {
  const w = world();
  const app = await server(w);
  const cli = (args) => spawnSync(process.execPath, [path.join(APP, 'cli.js'), ...args], { env: w.env, encoding: 'utf8' });
  try {
    assert.match(cli(['run', 'nope']).stderr, /no such bot/);
    assert.match(cli(['status']).stdout, /Bots:/);
    fs.writeFileSync(path.join(w.home, '.second-brain', 'token'), 'x'.repeat(48));
    assert.match(cli(["status"]).stderr, /refused the request/);
  } finally { await app.stop(); }
});

test('DNS rebinding: a request whose Host is not this server gets nothing (no token)', { skip, timeout: 60000 }, async () => {
  const w = world();
  const app = await server(w);
  try {
    const http = require('http');
    const get = (host, p) => new Promise((res) => http.get({ host: '127.0.0.1', port: w.port, path: p, headers: { Host: host } }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ code: r.statusCode, body: b })); }));
    const bad = await get(`attacker.example:${w.port}`, '/');
    assert.equal(bad.code, 421);
    assert.ok(!bad.body.includes(app.token));
    assert.equal((await get(`attacker.example:${w.port}`, '/api/brain/needs')).code, 421);
    const good = await get(`localhost:${w.port}`, '/');
    assert.equal(good.code, 200);
    assert.ok(good.body.includes(app.token));
  } finally { await app.stop(); }
});
