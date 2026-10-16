// Make me better's Apply and Undo: the gate between the dev copy (where a
// session edits) and the live kit (what the app runs). The model never
// applies its own change; this code does, after these checks:
//
//   lock ─▶ live sha ok? ─▶ dev clean? ─▶ rebase if mine moved ─▶ tests
//     ─▶ guard files / trusted tests changed? ──yes──▶ owner confirms
//     ─▶ smoke start (spare port, temp vault, steady /alive)
//     ─▶ hand over to the detached runner (apply-runner.js) ─▶ restart
//
// Guard files are the ones that judge or limit a change: the rules, the
// tests, this gate, the runner, and the bot safety flags. A change to one
// is never silent: the owner confirms it as its own list. The tests the live
// kit already trusted also run against the new code; a failure there (a
// behavior changed on purpose, or a test was weakened) is listed in the same
// confirm.

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const KG = require('./kit-git');
const AS = require('./apply-state');

const GUARDS = [/^PRINCIPLES\.md$/, /^tests\//, /^app\/test\//, /^app\/lib\/(kit-git|apply|apply-runner|apply-state|claude-call)\.js$/, /^app\/bot-settings\.json$/];
const isGuard = (f) => GUARDS.some((re) => re.test(f));
const devDir = (stateDir) => path.join(stateDir, 'kit-dev');

// The live kit must be where the last Apply/Undo/update left it. A session
// writes the shared .git and could move `mine` (git update-ref) without any
// check; this catches it.
function liveCheck(kit, stateDir) {
  if (KG.branch(kit) !== KG.MINE) return { ok: false, why: `the live kit is not on its own branch "${KG.MINE}"` };
  const a = AS.read(stateDir);
  const want = a && a.applied && a.applied[0];
  if (want && KG.head(kit) !== want) return { ok: false, why: `the live kit is at ${KG.head(kit).slice(0, 7)}, but the last Apply left it at ${want.slice(0, 7)}. Something moved it outside Apply; nothing was changed.` };
  if (!KG.trackedClean(kit)) return { ok: false, why: 'the live kit has edits of its own; changes go through the dev copy' };
  return { ok: true };
}

// Runs a command without blocking the server. Resolves { code, out }.
function sh(cmd, args, { cwd, env, timeoutMs = 15 * 60000 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGTERM'), timeoutMs);
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: String(e.message) }); });
  });
}
// The tests set their own SECOND_BRAIN_* values; the app's own (its state
// folder, its port) must not leak into them (found by the end-to-end run:
// the port and installer tests failed under a side install's environment).
function testEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('SECOND_BRAIN_')) delete env[k];
  return env;
}
const failing = (out) => out.split('\n').filter((l) => /^\s*FAIL\b|^✖ /.test(l)).map((l) => l.trim()).filter((l, i, all) => all.indexOf(l) === i).slice(0, 30);

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
}
function alive(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/alive', headers: { Host: `127.0.0.1:${port}` }, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(b) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// The new code starts on a spare port with a temp state dir and vault, no
// schedule. It must answer /alive with its own sha and the brain loaded, as
// the SAME process for settleMs.
async function smokeStart(dev, { node, settleMs = 35000, timeoutMs = 90000, log }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-smoke-'));
  const env = { ...testEnv(), SECOND_BRAIN_STATE_DIR: path.join(tmp, 'state'), SECOND_BRAIN_NO_LAUNCHCTL: '1', SECOND_BRAIN_NO_SCHEDULE: '1' };
  const st = await sh(node, [path.join(dev, 'app', 'cli.js'), 'setup', '--vault', path.join(tmp, 'Vault'), '--yes', '--name', 'Smoke', '--no-login-item', '--no-bind', '--no-dock-app'], { cwd: dev, env, timeoutMs: 120000 });
  if (st.code !== 0) return { ok: false, why: `setup of a temp vault failed: ${st.out.trim().split('\n').slice(-3).join(' ')}` };
  const port = await freePort();
  const srv = spawn(node, [path.join(dev, 'app', 'server.js')], { cwd: dev, env: { ...env, SECOND_BRAIN_PORT: String(port) }, stdio: 'ignore' });
  const sha = KG.head(dev);
  try {
    const deadline = Date.now() + timeoutMs;
    let first = null, brainless = 0;
    while (Date.now() < deadline) {
      if (srv.exitCode !== null) return { ok: false, why: `the new code exited (code ${srv.exitCode}) right after it started` };
      const r = await alive(port);
      // It answers, but its brain did not load: that does not fix itself.
      if (r && r.sha === sha && !r.brain) { if (!brainless) brainless = Date.now(); else if (Date.now() - brainless > 5000) return { ok: false, why: 'the new code started without its brain (brain.js did not load or start)' }; }
      if (r && r.sha === sha && r.brain) {
        if (!first || first.startedAt !== r.startedAt) { first = { ...r, seenAt: Date.now() }; log(`  smoke start: up on port ${port}, watching it for ${Math.round(settleMs / 1000)} s`); }
        else if (Date.now() - first.seenAt >= settleMs) return { ok: true };
      }
      await new Promise((r2) => setTimeout(r2, 2000));
    }
    return { ok: false, why: r0(first) };
  } finally { srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
}
const r0 = (first) => (first ? 'the new code did not stay up' : 'the new code never answered /alive with its brain loaded');

// The live kit's own tests (trusted) against the dev code: a shared clone
// at the dev commit, with tests/ and app/test/ from `mine`.
async function trustedTests(kit, devSha, log) {
  const o = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-trusted-'));
  try {
    if (KG.git(kit, 'clone', '-q', '--shared', kit, path.join(o, 'k')).status !== 0) return { failures: ['could not make the trusted-test copy'] };
    const k = path.join(o, 'k');
    KG.git(k, 'checkout', '-q', '-b', 'trusted', devSha);
    for (const d of ['tests', 'app/test']) KG.git(k, 'checkout', '-q', KG.head(kit, KG.MINE), '--', d); // a folder may not exist
    log('  running the live kit\'s own tests against the new code');
    const r = await sh('/bin/bash', [path.join(k, 'tests', 'run.sh')], { cwd: k, env: testEnv() });
    return { failures: r.code === 0 ? [] : (failing(r.out).length ? failing(r.out) : [`tests/run.sh exited ${r.code}`]) };
  } finally { fs.rmSync(o, { recursive: true, force: true }); }
}

let lastCheck = null; // { sha, guards, trustedFailures } of the dev commit checked last

// The Apply run. ctx: { kit, stateDir, node, port, restart, log, confirm,
// settleMs }. Returns { status: 'switching'|'confirm'|'error', summary, ... }.
// The caller (brain.js) holds no lock; this takes it and hands it to the runner.
async function apply(ctx) {
  const { kit, stateDir, log } = ctx;
  const dev = devDir(stateDir);
  if (!AS.lock(stateDir, 'apply')) return { status: 'error', summary: `the kit is being changed (${(AS.holder(stateDir) || {}).what || '?'}); try again when that ends` };
  let handed = false;
  try {
    const lc = liveCheck(kit, stateDir);
    if (!lc.ok) return { status: 'error', summary: lc.why };
    if (!fs.existsSync(path.join(dev, '.git'))) return { status: 'error', summary: 'there is no dev copy yet; open Make me better first' };
    if (!KG.isClean(dev)) return { status: 'error', summary: 'the dev copy has changes that are not committed. Ask the session to commit them (or Discard), then Apply. Only commits are applied.' };
    if (!KG.pending(kit)) return { status: 'error', summary: 'nothing to apply: the dev copy has no commits the app does not run yet' };
    if (KG.needsRebase(kit)) {
      log('your copy changed since this work started: replaying it on top');
      const rb = KG.rebaseDev(dev);
      if (!rb.ok) return { status: 'error', summary: 'Your copy changed since this session started, and the change does not replay cleanly on top. Open Make me better and ask it to bring this change up to date. Nothing was switched.' };
      lastCheck = null;
    }
    const sha = KG.head(dev);
    const from = KG.head(kit);
    let check = lastCheck && lastCheck.sha === sha ? lastCheck : null;
    if (!check) {
      log('running the tests in the dev copy (tests/run.sh)');
      const t = await sh('/bin/bash', [path.join(dev, 'tests', 'run.sh')], { cwd: dev, env: testEnv() });
      if (t.code !== 0) return { status: 'error', summary: 'the tests failed in the dev copy; nothing was switched', failures: failing(t.out) };
      log('  tests pass');
      const changed = KG.changedFiles(kit, KG.MINE, KG.DEV);
      const guards = changed.filter(isGuard);
      const trustedFailures = guards.some((f) => /^(tests|app\/test)\//.test(f)) ? (await trustedTests(kit, sha, log)).failures : [];
      check = lastCheck = { sha, guards, trustedFailures };
    }
    if ((check.guards.length || check.trustedFailures.length) && ctx.confirm !== sha) {
      return { status: 'confirm', sha, summary: 'this change touches the guard rails; confirm it to go on', guards: check.guards, trustedFailures: check.trustedFailures };
    }
    log('smoke start: the new code on a spare port');
    const sm = await smokeStart(dev, { node: ctx.node, settleMs: ctx.settleMs, timeoutMs: ctx.smokeTimeoutMs, log });
    if (!sm.ok) return { status: 'error', summary: `smoke start failed: ${sm.why}; nothing was switched` };
    // Hand over: the runner switches, restarts and rolls back if needed.
    const pid = startRunner(ctx, { mode: 'apply', from, to: sha });
    AS.handOver(stateDir, pid);
    handed = true;
    lastCheck = null;
    return { status: 'switching', summary: `switching to ${sha.slice(0, 7)}; the app restarts in a moment. If it does not come back, it goes back to ${from.slice(0, 7)} by itself.` };
  } finally { if (!handed) AS.unlock(stateDir); }
}

// Snapshot the runner and its two helpers out of the kit, then start it
// detached. Returns its pid.
function startRunner(ctx, { mode, from, to }) {
  const snap = path.join(ctx.stateDir, 'apply-runner');
  fs.rmSync(snap, { recursive: true, force: true });
  fs.mkdirSync(snap, { recursive: true });
  for (const f of ['apply-runner.js', 'kit-git.js', 'apply-state.js']) fs.copyFileSync(path.join(__dirname, f), path.join(snap, f));
  AS.write(ctx.stateDir, { state: 'switching', mode, from, to, reason: null });
  const arg = JSON.stringify({ kit: ctx.kit, stateDir: ctx.stateDir, mode, from, to, port: ctx.port, restart: ctx.restart, node: ctx.node, settleMs: ctx.settleMs, timeoutMs: ctx.timeoutMs });
  const logFd = fs.openSync(path.join(ctx.stateDir, 'apply.log'), 'a');
  const c = spawn(ctx.node, [path.join(snap, 'apply-runner.js'), arg], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env });
  c.unref();
  return c.pid;
}

// Undo: back to the commit before the last Apply (or Undo), through the same
// runner. Works from the page and from `second-brain rollback`.
function undo(ctx) {
  const { kit, stateDir } = ctx;
  const a = AS.read(stateDir);
  const target = a && a.applied && a.applied[1];
  if (!target) return { status: 'error', summary: 'there is no earlier Apply to go back to' };
  if (!AS.lock(stateDir, 'undo')) return { status: 'error', summary: 'the kit is being changed; try again when that ends' };
  const lc = liveCheck(kit, stateDir);
  if (!lc.ok) { AS.unlock(stateDir); return { status: 'error', summary: lc.why }; }
  const from = KG.head(kit);
  const pid = startRunner(ctx, { mode: 'undo', from, to: target });
  AS.handOver(stateDir, pid);
  return { status: 'switching', summary: `going back to ${target.slice(0, 7)}; the app restarts in a moment` };
}

// How the app restarts after a switch. A side install (SECOND_BRAIN_STATE_DIR:
// the release check, a demo) or a test (SECOND_BRAIN_NO_LAUNCHCTL) has no
// login item of its own: never touch the real one (side-install-stays-side).
function restartSpec(env = process.env) {
  if (env.SECOND_BRAIN_NO_LAUNCHCTL || env.SECOND_BRAIN_STATE_DIR) return { type: 'respawn' };
  const { LABEL } = require('./install');
  return { type: 'launchctl', label: LABEL, plist: path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`) };
}

module.exports = { restartSpec, GUARDS, isGuard, devDir, liveCheck, apply, undo, startRunner, smokeStart };
