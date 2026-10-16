// Feature notes and What's new (design: own your copy, Phase 2).
//
// Each user-visible change ships with a note, `features/<id>.md`:
//
//   ---
//   id: session-save-close            (the file name without .md)
//   title: Save & close copies a session to raw
//   kind: feature | fix | security
//   commits: [08b28b8]                 (earlier commits; the commit that
//                                       adds the note always counts too)
//   files: [app/lib/session-raw.js]    (the main files, for people)
//   principles: [raw-immutable]        (ids from PRINCIPLES.md)
//   ported_from: <upstream sha>        (only in a personal copy)
//   variant: as-is | customized        (only in a personal copy)
//   ---
//   Two or three sentences a user can read.
//
// A note made in a personal copy (Make me better) has an id that starts
// with "my-", so it can never take the id of a future upstream note.
//
// What's new compares the upstream notes with the local ones. It is code
// only: no model, no tokens, and no fetch of its own (it reads what the
// update check fetched).

const fs = require('fs');
const path = require('path');
const yaml = require('./vendor/js-yaml');
const KG = require('./kit-git');

const DIR = 'features';
const KINDS = ['feature', 'fix', 'security'];
const PERSONAL = /^my-/;

function parse(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(String(text).replace(/\r\n/g, '\n'));
  if (!m) return null;
  let meta;
  // Strings only: a short sha such as 29e0309 would read as a number.
  try { meta = yaml.load(m[1], { schema: yaml.FAILSAFE_SCHEMA }) || {}; } catch { return null; }
  if (typeof meta !== 'object' || Array.isArray(meta)) return null;
  const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);
  return {
    ...meta,
    id: meta.id == null ? '' : String(meta.id),
    commits: list(meta.commits),
    files: list(meta.files),
    principles: list(meta.principles),
    body: m[2].trim(),
  };
}

// The notes in a working tree (what this copy has, committed or not).
function local(dir) {
  const d = path.join(dir, DIR);
  let names = [];
  try { names = fs.readdirSync(d).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch { return []; }
  return names.sort().map((f) => {
    const n = parse(fs.readFileSync(path.join(d, f), 'utf8'));
    return n ? { ...n, file: `${DIR}/${f}` } : { file: `${DIR}/${f}`, invalid: true };
  });
}

// The notes at a git ref (the upstream's, after a fetch).
function atRef(dir, ref) {
  const r = KG.git(dir, 'ls-tree', '--name-only', `${ref}:${DIR}`);
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter((f) => f.endsWith('.md') && f !== 'README.md').sort().map((f) => {
    const s = KG.git(dir, 'show', `${ref}:${DIR}/${f}`);
    const n = s.status === 0 ? parse(s.stdout) : null;
    return n ? { ...n, file: `${DIR}/${f}` } : { file: `${DIR}/${f}`, invalid: true };
  });
}

const full = (dir, sha) => {
  const r = KG.git(dir, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`);
  return r.status === 0 ? r.stdout.trim() : null;
};
// The commit that added the note (on the history of `ref`), if any.
function addedIn(dir, file, ref = 'HEAD') {
  const r = KG.git(dir, 'log', '--format=%H', '--diff-filter=A', ref, '--', file);
  const shas = r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
  return shas.length ? shas[shas.length - 1] : null;
}
// Every commit of a note, as full shas: the listed ones and the one that
// added it. Unknown shas are returned apart, so a check can name them.
function commitsOf(dir, note, ref = 'HEAD') {
  const known = [], unknown = [];
  for (const c of note.commits) { const f = full(dir, c); if (f) known.push(f); else unknown.push(c); }
  const add = addedIn(dir, note.file, ref);
  if (add && !known.includes(add)) known.push(add);
  return { known, unknown };
}
function filesOf(dir, shas) {
  const set = new Set();
  for (const s of shas) {
    const r = KG.git(dir, 'show', '--name-only', '--format=', s);
    if (r.status === 0) for (const f of r.stdout.split('\n')) if (f.trim()) set.add(f.trim());
  }
  return set;
}

function principleIds(dir) {
  let t = '';
  try { t = fs.readFileSync(path.join(dir, 'PRINCIPLES.md'), 'utf8'); } catch { return new Set(); }
  return new Set([...t.matchAll(/^###\s+([a-z0-9-]+)\s*$/gm)].map((m) => m[1]));
}

// Problems in this copy's notes, one line each (the test fails on any).
function check(dir) {
  const ids = principleIds(dir);
  const errors = [];
  const seen = new Set();
  // Files changed but not committed yet: a note written with its change,
  // before the commit, lists files that no commit has yet.
  const st = KG.git(dir, 'status', '--porcelain', '--untracked-files=all');
  const dirty = new Set(st.status === 0 ? st.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '').trim()) : []);
  for (const n of local(dir)) {
    const at = n.file;
    if (n.invalid) { errors.push(`${at}: no frontmatter between --- lines, or it is not valid YAML`); continue; }
    const want = path.basename(at, '.md');
    if (n.id !== want) errors.push(`${at}: id is "${n.id}", but the file name says "${want}"`);
    if (seen.has(n.id)) errors.push(`${at}: the id "${n.id}" is used twice`);
    seen.add(n.id);
    if (!n.title || !String(n.title).trim()) errors.push(`${at}: no title`);
    if (!KINDS.includes(n.kind)) errors.push(`${at}: kind must be one of ${KINDS.join(', ')}`);
    if (!n.body) errors.push(`${at}: no text under the frontmatter (two or three sentences a user can read)`);
    for (const p of n.principles) if (!ids.has(p)) errors.push(`${at}: principle "${p}" is not in PRINCIPLES.md`);
    if (n.variant != null && !['as-is', 'customized'].includes(n.variant)) errors.push(`${at}: variant must be as-is or customized`);
    // A personal note, or a port of an upstream one, has commits that live
    // only in this copy or files that the port changed: no file check.
    if (PERSONAL.test(n.id) || n.ported_from) continue;
    const c = commitsOf(dir, n);
    for (const u of c.unknown) errors.push(`${at}: commit ${u} is not in this repo`);
    const changed = filesOf(dir, c.known);
    const added = addedIn(dir, at);
    if (!added) for (const f of dirty) changed.add(f);
    for (const f of n.files) if (!changed.has(f)) errors.push(`${at}: file ${f} is not changed by any of the note's commits`);
  }
  return errors;
}

// What's new: the upstream notes and how this copy stands on each.
//   update        a follower copy (no commits of its own) gets it with Update
//   new           not here; Bring this in ports it
//   may-conflict  not here, and it touches files this copy changed
//   have          here (same id)
//   have-version  here, as a customized port
// `other` lists upstream commits that no note covers, so a missing note
// degrades the feed and never hides a change.
function whatsNew(dir) {
  if (!KG.isRepo(dir)) return { error: `${dir} is not a git checkout` };
  const up = KG.upstream(dir);
  if (!up) return { error: 'this checkout tracks no upstream branch' };
  const count = (range) => Number((KG.git(dir, 'rev-list', '--count', range).stdout || '0').trim()) || 0;
  const ahead = count('@{u}..HEAD');
  const behind = count('HEAD..@{u}');
  const mine = new Map(local(dir).filter((n) => !n.invalid).map((n) => [n.id, n]));
  const base = (KG.git(dir, 'merge-base', 'HEAD', '@{u}').stdout || '').trim();
  const ownFiles = new Set();
  if (ahead && base) {
    const r = KG.git(dir, 'diff', '--name-only', `${base}..HEAD`);
    if (r.status === 0) for (const f of r.stdout.split('\n')) if (f.trim() && !f.startsWith(`${DIR}/`)) ownFiles.add(f.trim());
  }
  const covered = new Set();
  const items = [];
  for (const n of atRef(dir, '@{u}')) {
    if (n.invalid) continue;
    const c = commitsOf(dir, n, '@{u}');
    c.known.forEach((s) => covered.add(s));
    const have = mine.get(n.id);
    let status, conflicts = [];
    if (have) status = have.variant === 'customized' ? 'have-version' : 'have';
    else if (!ahead) status = 'update';
    else {
      const touched = new Set([...filesOf(dir, c.known), ...n.files]);
      conflicts = [...touched].filter((f) => ownFiles.has(f)).sort();
      status = conflicts.length ? 'may-conflict' : 'new';
    }
    const date = c.known.length ? (KG.git(dir, 'show', '-s', '--format=%cI', c.known[c.known.length - 1]).stdout || '').trim() : '';
    items.push({ id: n.id, title: String(n.title || n.id), kind: KINDS.includes(n.kind) ? n.kind : 'feature', body: n.body, principles: n.principles, files: n.files, commits: c.known, date, status, conflicts });
  }
  const rank = (i) => (i.status.startsWith('have') ? 2 : i.kind === 'feature' ? 1 : 0);
  items.sort((a, b) => rank(a) - rank(b) || String(b.date).localeCompare(String(a.date)));
  const other = [];
  if (behind) {
    const r = KG.git(dir, 'log', '--format=%H %s', '--no-decorate', '-50', 'HEAD..@{u}');
    for (const l of (r.stdout || '').split('\n').filter(Boolean)) {
      const sha = l.slice(0, 40);
      if (covered.has(sha)) continue;
      // A commit that only adds or edits notes is not a change of its own.
      const f = [...filesOf(dir, [sha])];
      if (f.length && f.every((x) => x.startsWith(`${DIR}/`))) continue;
      other.push({ sha: sha.slice(0, 7), subject: l.slice(41) });
    }
  }
  return { upstream: up, ahead, behind, follower: !ahead, items, other };
}

module.exports = { DIR, KINDS, parse, local, atRef, commitsOf, filesOf, check, whatsNew, principleIds };
