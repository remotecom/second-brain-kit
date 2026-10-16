// <STATE_DIR>/apply.json: what Make me better's Apply last did. The app
// reads it; the detached apply runner writes it. The runner runs from a
// snapshot copy (apply-runner/), so this file uses Node built-ins only.
//
//   {
//     state:   'switching' | 'applied' | 'rolled-back' | 'failed',
//     at:      ISO time of the last state change,
//     from:    sha the live kit ran before this switch,
//     to:      sha this switch moves the live kit to,
//     reason:  why it rolled back or failed (when it did),
//     applied: [sha, ...]   last 5 shas the live kit ran after an Apply,
//                           newest first; [0] is what `mine` must equal
//   }
//
//   switching ──alive──▶ applied
//       │
//       └──no alive / post step failed──▶ rolled-back
//
// While a switch is under way (state 'switching', less than HOLD_MS old),
// the scheduler starts no Morning run: the code may be rolled back within a
// minute, and a run started on it would be killed mid-sync.

const fs = require('fs');
const path = require('path');

const HOLD_MS = 5 * 60000;
const KEEP = 5;

const file = (stateDir) => path.join(stateDir, 'apply.json');

function read(stateDir) {
  try { return JSON.parse(fs.readFileSync(file(stateDir), 'utf8')); } catch { return null; }
}

// Merges fields into the record, stamps `at`, writes atomically.
function write(stateDir, fields) {
  const next = { ...(read(stateDir) || {}), ...fields, at: new Date().toISOString() };
  if (next.applied) next.applied = next.applied.slice(0, KEEP);
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${file(stateDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file(stateDir));
  return next;
}

function switching(stateDir, now = Date.now()) {
  const a = read(stateDir);
  return !!(a && a.state === 'switching' && now - Date.parse(a.at) < HOLD_MS);
}

// One lock for everything that moves the live kit: Apply, Undo and
// `second-brain update` (from the page or a terminal). Holds the pid; a lock
// whose process is gone is taken over.
const lockFile = (stateDir) => path.join(stateDir, 'apply.lock');
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function lock(stateDir, what) {
  fs.mkdirSync(stateDir, { recursive: true });
  const f = lockFile(stateDir);
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, what, at: new Date().toISOString() }), { flag: 'wx' }); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      if (cur.pid && alive(cur.pid)) return false;
      fs.rmSync(f, { force: true });
    }
  }
  return false;
}
function holder(stateDir) { try { return JSON.parse(fs.readFileSync(lockFile(stateDir), 'utf8')); } catch { return null; } }
// Hands the lock to another process (the detached runner).
function handOver(stateDir, pid) { const h = holder(stateDir) || {}; fs.writeFileSync(lockFile(stateDir), JSON.stringify({ ...h, pid })); }
function unlock(stateDir) {
  const h = holder(stateDir);
  if (h && h.pid === process.pid) fs.rmSync(lockFile(stateDir), { force: true });
}

module.exports = { HOLD_MS, KEEP, file, read, write, switching, lock, unlock, holder, handOver };
