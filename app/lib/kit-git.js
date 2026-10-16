// Every git command the app runs on a kit checkout. One place, so update,
// Apply, Undo and the apply runner agree on the rules. Node built-ins only:
// the apply runner runs a snapshot copy of this file (see apply.js).
//
// Layout of a copy that used Make me better (design: own your copy):
//
//   origin (public repo)  <upstream> ──●──●──●──────●   the feed
//                                       \
//   live kit (KIT_DIR)    mine ──────────●──●            what the app runs
//                                             \
//   dev copy (kit-dev)    mine-dev ────────────●         where sessions edit
//
// `mine` tracks the upstream the live kit tracked before (often not master),
// so `update` still fast-forwards a copy with no commits of its own.
//
// Hooks and fsmonitor are OFF for every command. The dev copy is a worktree:
// its sandboxed session must write the shared .git to commit, so it could
// plant a hook or a config value there. The app runs git outside the
// sandbox; with hooks off, nothing the session wrote runs with the app's
// rights.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const MINE = 'mine';
const DEV = 'mine-dev';

function git(dir, ...args) {
  return spawnSync('/usr/bin/git', ['-C', dir, ...SAFE, ...args], { encoding: 'utf8' });
}
const out = (r) => (r.status === 0 ? r.stdout.trim() : null);
const err = (r) => String(r.stderr || '').trim().split('\n')[0];

const isRepo = (dir) => git(dir, 'rev-parse', '--git-dir').status === 0;
const head = (dir, ref = 'HEAD') => out(git(dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`));
const branch = (dir) => out(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'));
const upstream = (dir, b = 'HEAD') => out(git(dir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', `${b}@{u}`));
const count = (dir, range) => Number(out(git(dir, 'rev-list', '--count', range)) || 0);
// Untracked files count: they would pass the tests but never ship.
const isClean = (dir) => out(git(dir, 'status', '--porcelain')) === '';
const trackedClean = (dir) => out(git(dir, 'status', '--porcelain', '--untracked-files=no')) === '';

// How the live kit stands against its upstream. behind: upstream commits not
// here. ahead: commits here not upstream (the owner's own changes).
function kitBehind(dir, { fetch = true } = {}) {
  if (!isRepo(dir)) return { error: `${dir} is not a git checkout; reinstall from the repo` };
  if (fetch) { const f = git(dir, 'fetch', '--quiet'); if (f.status !== 0) return { error: `git fetch failed: ${err(f)}` }; }
  const up = upstream(dir);
  if (!up) return { error: 'this checkout tracks no upstream branch' };
  const behind = count(dir, 'HEAD..@{u}');
  const ahead = count(dir, '@{u}..HEAD');
  const log = behind ? out(git(dir, 'log', '--oneline', '--no-decorate', 'HEAD..@{u}')).split('\n') : [];
  return { behind, ahead, upstream: up, log };
}

// First use of Make me better: the live kit moves to local branch `mine`,
// keeping the upstream it tracked. Idempotent.
function ensureMine(dir) {
  if (branch(dir) === MINE) return { created: false };
  const up = upstream(dir);
  if (!up) throw new Error('the kit tracks no upstream branch, so its own branch cannot follow one');
  if (head(dir, MINE)) throw new Error(`a branch "${MINE}" exists but is not checked out; check out "${MINE}" in ${dir} first`);
  let r = git(dir, 'checkout', '-q', '-b', MINE);
  if (r.status !== 0) throw new Error(`could not create "${MINE}": ${err(r)}`);
  r = git(dir, 'branch', `--set-upstream-to=${up}`, MINE);
  if (r.status !== 0) throw new Error(`could not set the upstream of "${MINE}": ${err(r)}`);
  return { created: true, upstream: up };
}

// The dev copy: a worktree of the live kit on `mine-dev`. Made again when
// the folder was deleted by hand.
function ensureDev(liveDir, devDir) {
  if (fs.existsSync(path.join(devDir, '.git')) && branch(devDir) === DEV) return { created: false };
  if (fs.existsSync(devDir)) throw new Error(`${devDir} exists but is not the dev copy; move it away`);
  git(liveDir, 'worktree', 'prune');
  const r = head(liveDir, DEV)
    ? git(liveDir, 'worktree', 'add', '-q', devDir, DEV)
    : git(liveDir, 'worktree', 'add', '-q', '-b', DEV, devDir, MINE);
  if (r.status !== 0) throw new Error(`could not make the dev copy: ${err(r)}`);
  return { created: true };
}

// Commits in the dev copy that the live kit does not run yet.
const pending = (liveDir) => count(liveDir, `${MINE}..${DEV}`);
// `mine` moved since mine-dev forked (an update, a port, an Undo).
const needsRebase = (liveDir) => out(git(liveDir, 'merge-base', MINE, DEV)) !== head(liveDir, MINE);

// Replays mine-dev on top of mine. On a conflict, aborts and reports it.
function rebaseDev(devDir) {
  const r = git(devDir, 'rebase', '-q', MINE);
  if (r.status === 0) return { ok: true };
  git(devDir, 'rebase', '--abort');
  return { ok: false, error: err(r) || 'rebase conflict' };
}

// Discard: the dev copy goes back to what the live kit runs.
function resetDev(devDir) {
  const r = git(devDir, 'reset', '-q', '--hard', MINE);
  if (r.status !== 0) throw new Error(`could not reset the dev copy: ${err(r)}`);
  git(devDir, 'clean', '-qfd');
}

// The switch and the way back. The live kit has no edits of its own, so a
// hard reset loses nothing.
function ffLive(liveDir) {
  const r = git(liveDir, 'merge', '--ff-only', '-q', DEV);
  if (r.status !== 0) throw new Error(`the live kit could not fast-forward: ${err(r)}`);
  return head(liveDir);
}
function resetLive(liveDir, sha) {
  const r = git(liveDir, 'reset', '-q', '--hard', sha);
  if (r.status !== 0) throw new Error(`could not reset the live kit to ${sha}: ${err(r)}`);
  return head(liveDir);
}

// Files changed between two refs (for the guard-file confirm).
function changedFiles(dir, from, to) {
  const o = out(git(dir, 'diff', '--name-only', `${from}..${to}`));
  return o ? o.split('\n') : [];
}

module.exports = {
  MINE, DEV, SAFE, git, isRepo, head, branch, upstream, isClean, trackedClean, kitBehind,
  ensureMine, ensureDev, pending, needsRebase, rebaseDev, resetDev, ffLive, resetLive, changedFiles,
};
