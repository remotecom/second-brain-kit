// The real server in a temp HOME, with a fake `claude` that answers the
// doctor (--version, --help, auth status) and acts as an interactive
// session. Shared by the end-to-end tests.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { FLAGS } = require('../../lib/doctor');

const APP = path.join(__dirname, '..', '..');

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
module.exports = { world, server, APP };
