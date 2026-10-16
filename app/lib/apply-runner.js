#!/usr/bin/env node
// The apply runner: switches the live kit to new code, checks that the app
// came back, and rolls back when it did not. It runs DETACHED, from a
// snapshot copy in <STATE_DIR>/apply-runner/ (apply.js makes it), because the
// restart kills the app process that started it, and because the switch
// replaces the kit's own files: a runner that loaded code from the kit could
// run its rollback on the very code it rolls back.
//
// So: Node built-ins, ./kit-git and ./apply-state only. A test checks this.
//
//   switch ──▶ post step ──▶ restart ──▶ /alive steady? ──yes──▶ applied
//                 │                          │
//                 └──fails──┐                no
//                           ▼                ▼
//                 reset to `from` ──▶ post step ──▶ reload launchd ──▶ rolled-back
//
// One JSON argument:
//   { kit, stateDir, mode: 'apply'|'undo', from, to, port,
//     restart: { type: 'launchctl', label, plist }   the login item (normal)
//            | { type: 'respawn' }   no launchd (a side install, the release
//                                     check): stop the pid /alive reports and
//                                     start server.js again, same environment
//            | { type: 'none' }      tests that watch the checkout instead
//     settleMs, timeoutMs, node }

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const KG = require('./kit-git');
const AS = require('./apply-state');

const a = JSON.parse(process.argv[2] || '{}');
const LOG = path.join(a.stateDir, 'apply.log');
const log = (m) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/alive', headers: { Host: `127.0.0.1:${port}` }, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(b) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Up = the expected commit, the brain loaded, and the SAME process across
// polls spanning settleMs (launchd restarts a crashing app every 30 s, which
// would show as a new startedAt).
async function steady(sha) {
  const settle = a.settleMs ?? 35000, deadline = Date.now() + (a.timeoutMs ?? 120000);
  let first = null;
  while (Date.now() < deadline) {
    const r = await alive(a.port);
    if (r && r.sha === sha && r.brain) {
      if (!first || first.startedAt !== r.startedAt) first = { ...r, seenAt: Date.now() };
      else if (Date.now() - first.seenAt >= settle) return true;
    } else first = null;
    await sleep(2000);
  }
  return false;
}

function post() {
  const r = spawnSync(a.node || process.execPath, [path.join(a.kit, 'app', 'cli.js'), 'update', '--post', '--write'], { encoding: 'utf8', timeout: 120000, env: process.env });
  log(`post step exit ${r.status}: ${String(r.stdout || '').trim().split('\n').join(' | ')}${r.stderr ? ` ERR ${String(r.stderr).trim().split('\n')[0]}` : ''}`);
  return r.status === 0;
}

async function restart(clean) {
  const rs = a.restart || { type: 'none' };
  if (rs.type === 'respawn') {
    const r = await alive(a.port);
    if (r && r.pid && r.pid !== process.pid) { try { process.kill(r.pid, 'SIGTERM'); } catch {} }
    for (let i = 0; i < 25 && (await alive(a.port)); i++) await sleep(200);
    spawn(a.node || process.execPath, [path.join(a.kit, 'app', 'server.js')], { detached: true, stdio: 'ignore', env: { ...process.env, SECOND_BRAIN_PORT: String(a.port) } }).unref();
    return;
  }
  if (rs.type !== 'launchctl') return;
  const dom = `gui/${process.getuid()}`;
  if (clean) {
    // A crash loop must not race the old code: unload, then load again.
    spawnSync('/bin/launchctl', ['bootout', `${dom}/${rs.label}`], { stdio: 'ignore' });
    spawnSync('/bin/launchctl', ['bootstrap', dom, rs.plist], { stdio: 'ignore' });
  } else {
    spawnSync('/bin/launchctl', ['kickstart', '-k', `${dom}/${rs.label}`], { stdio: 'ignore' });
  }
}

async function main() {
  log(`${a.mode} ${a.from} -> ${a.to}`);
  let why = '';
  try {
    if (a.mode === 'apply') {
      const got = KG.ffLive(a.kit);
      if (got !== a.to) throw new Error(`fast-forward reached ${got}, expected ${a.to}`);
    } else {
      KG.resetLive(a.kit, a.to);
    }
    if (!post()) why = 'the new code failed its update step';
    else {
      await restart(false);
      if (!(await steady(a.to))) why = 'the app did not come back on the new code (no steady /alive with the brain loaded)';
    }
  } catch (e) { why = e.message; }

  if (!why) {
    const prev = AS.read(a.stateDir) || {};
    const applied = a.mode === 'undo' ? (prev.applied || []).slice(1) : [a.to, ...((prev.applied && prev.applied.length) ? prev.applied : [a.from])];
    AS.write(a.stateDir, { state: 'applied', mode: a.mode, from: a.from, to: a.to, reason: null, applied: applied.length ? applied : [a.to] });
    log(`${a.mode} done: ${a.to}`);
  } else {
    log(`FAILED: ${why}; rolling back to ${a.from}`);
    try { KG.resetLive(a.kit, a.from); } catch (e) { log(`reset failed: ${e.message}`); }
    post();
    await restart(true);
    const back = await steady(a.from);
    AS.write(a.stateDir, { state: 'rolled-back', mode: a.mode, from: a.from, to: a.to, reason: why + (back ? '' : '; the old code did not come back either: run `second-brain doctor`') });
    log(back ? 'rolled back' : 'rolled back, but the app is not answering');
  }
  AS.unlock(a.stateDir);
}

main().catch((e) => { log(`runner crashed: ${e.stack || e.message}`); try { AS.write(a.stateDir, { state: 'failed', reason: e.message }); AS.unlock(a.stateDir); } catch {} process.exit(1); });
