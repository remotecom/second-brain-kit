// Google Drive sync, "model presses buttons, code writes". Replaces the
// model-written sync, which on 2026-10-02 left 6 gaps in one run: a file block
// cut off by a safety classifier, 4 files never emitted, 2 never fetched, and
// the state files not written, so the watermark held.
//
//   T = MIN(window start (4 days), watermark); 30 days on first run
//     ▼
//   discovery (haiku presses, code pages):
//     search_files owner = 'me' and modifiedTime > T          → owned
//     list_recent_files orderBy lastModifiedByMe (no time filter; the runner
//       stops paging once a page reaches files older than T, max 10 pages) → last_edited_by_me
//     search_files parentId = <watched folder> and modifiedTime > T → watched_folder
//     ▼
//   code: MIME allowlist ─▶ ancestor walk (get_file_metadata, memoized in
//         .parent-cache.json; any ancestor in config gdrive.exclude_folders or titled
//         "Meet Recordings"/"Google Meet" ─▶ excluded) ─▶ pre-fetch skip (.state.json)
//     ▼
//   haiku: read_file_content(includeComments) ─▶ code renders gdrive/files/<id>.md
//     ▼
//   sync.verify ─▶ sync.commit (hash skip) ─▶ state files ─▶ watermark
//
// A read that fails goes on .bot/state/gdrive-pending.json and is retried next
// run (plan D13); only a failed LIST holds the watermark.

const fs = require('fs');
const path = require('path');
const { verify, commit } = require('./sync');
const { collect } = require('./buttons');
const { getConfig } = require('./config');
const { readPending, writePending } = require('./ledger');

const P = 'mcp__claude_ai_Google_Drive__';
const SEARCH = `${P}search_files`, RECENT = `${P}list_recent_files`, META = `${P}get_file_metadata`, READ = `${P}read_file_content`;
const DAY = 864e5;
const RECENT_MAX_PAGES = 10, MAX_DEPTH = 12;

// What read_file_content can read, and the short tag each gets.
const MIME = {
  'application/vnd.google-apps.document': 'doc',
  'application/vnd.google-apps.presentation': 'slides',
  'application/vnd.google-apps.spreadsheet': 'sheet',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/x-vnd.oasis.opendocument.text': 'odt',
};

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const q = (s) => JSON.stringify(String(s == null ? '' : s));

function render(meta, content, reasons, parentTitle, maxBody = 50000) {
  let body = String(content || '').replace(/\s+$/, '');
  let truncated = false;
  if (body.length > maxBody) { body = `${body.slice(0, maxBody)}\n\n[truncated at ${maxBody} chars — full document at the web_link above]`; truncated = true; }
  return [
    '---',
    `gdrive_id: ${meta.id}`,
    `title: ${q(meta.title)}`,
    `mime_type: ${meta.mimeType}`,
    `owner: ${meta.owner || 'null'}`,
    `parent_id: ${meta.parentId || 'null'}`,
    `parent_title: ${q(parentTitle || '')}`,
    `web_link: ${meta.viewUrl || 'null'}`,
    `created_time: ${meta.createdTime || 'null'}`,
    `modified_time: ${meta.modifiedTime || 'null'}`,
    `in_scope_reasons: [${reasons.join(', ')}]`,
    `truncated: ${truncated}`,
    `tags: [gdrive, gdrive/${MIME[meta.mimeType] || 'file'}]`,
    '---', '',
    `# ${meta.title}`, '',
    body, '',
  ].join('\n');
}

async function syncGdriveMcp(run, ctx) {
  const { vault, logLine, finish, src } = ctx;
  const log = (s) => logLine(run, s);
  const dir = path.join(vault, 'gdrive');
  const statePath = path.join(dir, '.state.json'), cachePath = path.join(dir, '.parent-cache.json');
  const state = readJson(statePath, {}), cache = readJson(cachePath, {});
  const watched = readJson(path.join(dir, '.allowlist'), []);
  const gd = getConfig(vault).sources.gdrive;
  const excludeIds = new Set(gd.exclude_folders.map(String));
  const EXCLUDED_TITLES = new Set(gd.exclude_folder_titles.map(String));
  let cost = 0;

  let wm = null; try { wm = Date.parse(fs.readFileSync(path.join(dir, '.last-sync'), 'utf8').trim()); } catch {}
  const now = Date.now();
  const bootDays = getConfig(vault).bootstrap_days;
  const windowStart = now - gd.window_days * DAY;
  const T = Number.isFinite(wm) ? Math.min(windowStart, wm) : now - bootDays * DAY;
  const tIso = new Date(T).toISOString().replace(/\.\d+Z$/, 'Z');
  log(`files modified after ${tIso}${Number.isFinite(wm) ? '' : ` (first run, ${bootDays}-day bootstrap)`} · ${watched.length} watched folder(s) · haiku presses, runner writes`);

  // 1. Discovery.
  const listPage = (j) => (Array.isArray(j.files) ? { items: j.files, next: j.nextPageToken || null } : null);
  const searchJobs = [{ args: { query: `owner = 'me' and modifiedTime > '${tIso}'`, pageSize: 100 }, reason: 'owned' },
    ...watched.map((w) => ({ args: { query: `parentId = '${w.folder_id}' and modifiedTime > '${tIso}'`, pageSize: 100 }, reason: 'watched_folder' }))];
  const s = await collect(ctx, run, SEARCH, searchJobs, { pageOf: listPage, cursorKey: 'pageToken', batch: 10, budget: 1, label: 'search_files' });
  cost += s.cost;
  // list_recent_files has no time filter: page until a page reaches files older than T.
  let pages = 0;
  const r = await collect(ctx, run, RECENT, [{ args: { orderBy: 'lastModifiedByMe', pageSize: 50 } }], {
    pageOf: (j) => {
      const pg = listPage(j); if (!pg) return null;
      pages++;
      const oldest = Math.min(...pg.items.map((f) => Date.parse(f.modifiedTime || 0)));
      return { items: pg.items, next: pages < RECENT_MAX_PAGES && oldest > T ? pg.next : null };
    },
    cursorKey: 'pageToken', followPages: false, budget: 1, maxRounds: RECENT_MAX_PAGES + 2, label: 'list_recent_files',
  });
  cost += r.cost;
  if (s.unfinished.length || r.unfinished.length) {
    return finish(run, 'error', `a file listing never finished (${s.unfinished.length + r.unfinished.length}); nothing written, watermark NOT moved`, { unfinished: [...s.unfinished, ...r.unfinished] }, cost);
  }
  const found = new Map(); // id -> { meta, reasons:Set }
  const add = (f, reason) => {
    if (!f || !f.id || Date.parse(f.modifiedTime || 0) <= T) return;
    if (!found.has(f.id)) found.set(f.id, { meta: f, reasons: new Set() });
    found.get(f.id).reasons.add(reason);
  };
  for (const j of searchJobs) for (const f of s.results.get(s.keyOf(j.args)) || []) add(f, j.reason);
  for (const f of [...r.results.values()].flat()) add(f, 'last_edited_by_me');
  const pending = readPending(vault, 'gdrive');
  for (const p of pending) if (p && p.id && !found.has(p.id)) found.set(p.id, { meta: p, reasons: new Set(p.reasons || ['owned']) });
  log(`found ${found.size} file(s) modified in range${pending.length ? ` (incl. ${pending.length} retried from the pending list)` : ''} · recent list: ${pages} page(s)`);

  // 2. MIME allowlist.
  const counts = { found: found.size, excluded_by_folder_tree: 0, excluded_by_mime: 0, prefetch_skipped: 0, fetched: 0, written: 0, unchanged: 0, truncated: 0, ancestry_unknown: 0 };
  for (const [id, x] of found) if (!MIME[x.meta.mimeType]) { found.delete(id); counts.excluded_by_mime++; }

  const pendingNext = []; // reads that failed or folders we could not resolve: retried next run

  // 3. Ancestor walk, memoized. Each round fetches the folders nobody has seen yet.
  const chainOf = (id) => { const out = []; let cur = id; for (let i = 0; cur && i < MAX_DEPTH; i++) { out.push(cur); if (!(cur in cache)) return { out, unknown: cur }; cur = cache[cur].parentId; } return { out, unknown: null }; };
  for (let round = 0; round < MAX_DEPTH; round++) {
    const unknown = new Set();
    for (const x of found.values()) { const c = chainOf(x.meta.parentId); if (c.unknown) unknown.add(c.unknown); }
    if (!unknown.size) break;
    const m = await collect(ctx, run, META, [...unknown].map((fid) => ({ args: { fileId: fid } })), {
      pageOf: (j) => (j && j.id ? { items: [j], next: null } : null), batch: 25, budget: 1, maxRounds: 2, label: `folder metadata (depth ${round + 1})`,
    });
    cost += m.cost;
    let got = 0;
    for (const items of m.results.values()) for (const f of items) { cache[f.id] = { parentId: f.parentId || null, title: f.title || '' }; got++; }
    if (!got) break;
  }
  for (const [id, x] of [...found]) {
    const c = chainOf(x.meta.parentId);
    if (c.unknown) { found.delete(id); counts.ancestry_unknown++; x.meta.reasons = [...x.reasons]; pendingNext.push(x.meta); continue; }
    if (c.out.some((fid) => excludeIds.has(fid) || EXCLUDED_TITLES.has((cache[fid] || {}).title))) { found.delete(id); counts.excluded_by_folder_tree++; }
  }

  // 4. Pre-fetch skip: unchanged modifiedTime means an unchanged body.
  for (const [id, x] of [...found]) if (state[id] && state[id] === x.meta.modifiedTime && fs.existsSync(path.join(dir, 'files', `${id}.md`))) { found.delete(id); counts.prefetch_skipped++; }

  // 5. Fetch bodies, comments inlined.
  const files = new Map();
  if (found.size) {
    const f = await collect(ctx, run, READ, [...found.keys()].map((id) => ({ args: { fileId: id, includeComments: true } })), {
      pageOf: (j) => (j && typeof j.fileContent === 'string' ? { items: [j], next: null } : null), batch: 8, budget: 3, maxRounds: 2, label: 'read_file_content',
    });
    cost += f.cost;
    for (const [id, x] of found) {
      const got = (f.results.get(f.keyOf({ fileId: id, includeComments: true })) || [])[0];
      if (!got) { x.meta.reasons = [...x.reasons]; pendingNext.push(x.meta); continue; }
      counts.fetched++;
      const text = render(x.meta, got.fileContent, [...x.reasons], (cache[x.meta.parentId] || {}).title, gd.max_body_chars);
      if (/^truncated: true$/m.test(text)) counts.truncated++;
      files.set(`gdrive/files/${id}.md`, text);
    }
  }

  const { problems, notes } = verify(vault, src, { emitted: [...files.keys()] }, files, { since: T, today: now }, { modelAuthored: false });
  for (const n of notes) log(`note: ${n}`);
  for (const p of problems) log(`GATE: ${p}`);
  if (problems.length) return finish(run, 'error', `gate failed (${problems.length}); nothing written`, { problems }, cost);
  const { written, skipped } = commit(vault, files);
  counts.written = written; counts.unchanged = skipped;
  for (const [rel, text] of files) state[path.basename(rel, '.md')] = (text.match(/^modified_time: (.+)$/m) || [])[1];
  fs.writeFileSync(statePath, `${JSON.stringify(Object.fromEntries(Object.entries(state).sort()), null, 1)}\n`);
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 1)}\n`);
  writePending(vault, 'gdrive', pendingNext);

  // Watermark: newest modifiedTime listed (listings all finished; failed reads are on the ledger).
  const maxMod = Math.max(0, ...[...s.results.values(), ...r.results.values()].flat().map((x) => Date.parse(x.modifiedTime || 0)).filter((t) => t <= now));
  let moved = 'unchanged';
  if (maxMod && (!Number.isFinite(wm) || maxMod > wm)) {
    fs.writeFileSync(path.join(dir, '.last-sync'), `${new Date(maxMod).toISOString().replace(/\.\d+Z$/, 'Z')}\n`);
    moved = `→ ${new Date(maxMod).toISOString().slice(0, 16)}Z`;
  }
  const summary = `${written} written, ${skipped} unchanged · found ${counts.found}, excluded ${counts.excluded_by_folder_tree} by folder tree + ${counts.excluded_by_mime} by type, ${counts.prefetch_skipped} unchanged before fetch, ${counts.fetched} fetched${counts.truncated ? `, ${counts.truncated} truncated at 50K` : ''} · watermark ${moved}${pendingNext.length ? ` · ${pendingNext.length} pending for next run` : ''}`;
  log('comments are inlined for Docs, Sheets and Slides only; PDFs and Office files carry none');
  finish(run, pendingNext.length ? 'warn' : 'ok', summary, counts, cost);
}

module.exports = { syncGdriveMcp, render, MIME };
