// Notion sync through the claude.ai Notion connector. Same pattern as Slack
// and Linear: the runner decides every call, haiku presses the buttons, and
// code writes notion/pages/<uuid>.md from the raw results.
//
//   discover  notion-search with the spec's signals, unioned by page id:
//             last_edited_by me · created_by me · mentions (owner.name from config.yaml)
//             (search needs a non-empty query; "the", "a" and "Remote" are
//             used as catch-alls, measured 2026-10-01: "*" returns nothing)
//   detail    notion-fetch (page body + properties) + notion-get-comments
//   render    existing raw format; body = the connector's enhanced markdown
//   gate      sync.verify ─▶ sync.commit (hash skip) ─▶ watermark if complete
//
// Watched sources from notion/.allowlist (spec step 4d): a watched page joins
// when search shows it edited in range; a watched database contributes rows
// created in range (notion-query-data-sources). Not covered, and said so in the
// log: walking a watched page's child pages, and edits to old database rows
// (the spec's own limit: most data sources only expose createdTime).

const fs = require('fs');
const path = require('path');
const { collect } = require('./buttons');
const { verify, commit } = require('./sync');
const { requireOwner, getConfig } = require('./config');
const { readPending, writePending } = require('./ledger');
const { tool } = require('./connectors');

const DAY = 86400000;
const CATCHALL = ['the', 'a', 'Remote'];
const COMMENT_TRIES = 3;
const COMMENTS_UNFETCHED = `_Comments not fetched: the connector returned no result in ${COMMENT_TRIES} consecutive runs._`;

const q = (v) => (v === null || v === undefined || v === '' ? 'null' : JSON.stringify(String(v)));
const flat = (id) => String(id).replace(/-/g, '');
// Search timestamps look like "1 day ago (2026-10-01)". Comparing that string to
// a date dropped every page edited "1 day", "1x days" or "1 month" ago (found 2026-10-02).
const tsDay = (t) => (String(t || '').match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
const dashed = (id) => { const f = flat(id); return `${f.slice(0, 8)}-${f.slice(8, 12)}-${f.slice(12, 16)}-${f.slice(16, 20)}-${f.slice(20)}`; };

// The vault has both flat and hyphenated filenames for some pages (a known
// schism). Reuse whichever already exists so a sync never creates a duplicate;
// new pages get the majority (flat) form.
function filenameFor(vault, id) {
  for (const name of [flat(id), dashed(id)]) if (fs.existsSync(path.join(vault, 'notion', 'pages', `${name}.md`))) return `notion/pages/${name}.md`;
  return `notion/pages/${flat(id)}.md`;
}

function decodeEntities(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function renderComments(xml) {
  const out = [];
  for (const d of String(xml || '').matchAll(/<discussion\b([^>]*)>([\s\S]*?)<\/discussion>/g)) {
    const ctxText = (d[1].match(/text-context="([^"]*)"/) || [])[1];
    const resolved = /resolved="true"/.test(d[1]);
    let first = true;
    for (const c of d[2].matchAll(/<comment\b([^>]*)>([\s\S]*?)<\/comment>/g)) {
      const who = ((c[1].match(/user-url="user:\/\/[^/"]*\/?([^"]*)"/) || [])[1] || 'unknown').replace(/@.*/, '');
      const when = (c[1].match(/datetime="([^"]*)"/) || [])[1] || '';
      const url = decodeEntities((c[1].match(/ url="([^"]*)"/) || [])[1] || '');
      const body = decodeEntities(c[2]
        .replace(/<mention-user[^>]*>([^<]*)<\/mention-user>/g, '@$1')
        .replace(/<mention-user[^>]*\/>/g, '@someone')
        .replace(/<[^>]+>/g, '')).trim();
      const pad = first ? '' : '  ';
      out.push(`${pad}- **${who}** · ${when}${url ? ` [↗](${url})` : ''}${first && ctxText ? ` · on "${decodeEntities(ctxText)}"` : ''}${first && resolved ? ' · resolved' : ''}`);
      out.push(...body.split('\n').map((l) => `${pad}  ${l}`));
      first = false;
    }
  }
  return out.length ? out.join('\n') : '_No comments._';
}

async function syncNotionMcp(run, ctx) {
  const { vault, logLine, finish, src } = ctx;
  const log = (s) => logLine(run, s);
  const T = (name) => tool(vault, 'notion', name);
  let owner;
  try { owner = requireOwner(vault, ['notion_user_id', 'name']); } catch (e) { return finish(run, 'error', e.message); }
  const me = owner.notion_user_id;

  const cfg = getConfig(vault);
  const now = Date.now();
  const utcToday = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const windowStart = utcToday - (cfg.sources.notion.window_days - 1) * DAY;
  let wm = null;
  try { wm = Date.parse(fs.readFileSync(path.join(vault, 'notion', '.last-sync'), 'utf8').trim()); } catch {}
  const since = Number.isFinite(wm) ? Math.min(windowStart, wm) : utcToday - (cfg.bootstrap_days - 1) * DAY;
  const startDate = new Date(since).toISOString().slice(0, 10);
  log(`edited since ${startDate} · haiku presses buttons, runner writes`);
  let cost = 0;
  const unfinished = [];

  // 1. Discover. Each signal is its own search; reasons are merged per page.
  const range = { last_edited_date_range: { start_date: startDate } };
  const signals = [
    ...CATCHALL.map((query) => ({ reason: 'last_edited_by_me', args: { query, filters: { edited_by_user_ids: [me], ...range }, page_size: 50, sort: 'last_edited', max_highlight_length: 0 } })),
    ...CATCHALL.map((query) => ({ reason: 'created_by_me', args: { query, filters: { created_by_user_ids: [me], ...range }, page_size: 50, sort: 'last_edited', max_highlight_length: 0 } })),
    { reason: 'mentioned', args: { query: owner.name, filters: { ...range }, page_size: 50, sort: 'last_edited', max_highlight_length: 0 } },
  ];
  // notion-search returns at most page_size results and no cursor; a full
  // page of 50 is therefore flagged, since more may exist past it.
  const disc = await collect(ctx, run, T('notion-search'), signals, { pageOf: (j) => (Array.isArray(j.results) ? { items: j.results, next: null } : null), batch: 7, label: 'search' });
  cost += disc.cost; unfinished.push(...disc.unfinished);
  const pages = new Map(); // flat id -> { id, title, url, timestamp, reasons:Set }
  for (const s of signals) {
    const hits = disc.results.get(disc.keyOf(s.args)) || [];
    if (hits.length >= 50) log(`note: "${s.args.query}" (${s.reason}) returned a full page of 50; results beyond it may be missed`);
    for (const h of hits) {
      if (h.type && h.type !== 'page') continue;
      if (tsDay(h.timestamp) < startDate) continue;
      const k = flat(h.id);
      if (!pages.has(k)) pages.set(k, { ...h, reasons: new Set() });
      pages.get(k).reasons.add(s.reason);
    }
  }
  const listFailed = [...disc.unfinished];

  // 1b. Watched sources (notion/.allowlist).
  let allow = []; try { allow = JSON.parse(fs.readFileSync(path.join(vault, 'notion', '.allowlist'), 'utf8')); } catch {}
  const wPages = allow.filter((a) => a.type === 'page' && a.id && a.name);
  const wDbs = allow.filter((a) => a.type === 'database' && a.data_source_id);
  const addPage = (h, reason) => {
    const k = flat(h.id);
    if (!pages.has(k)) pages.set(k, { id: h.id, title: h.title, url: h.url, timestamp: h.timestamp || h.createdTime, reasons: new Set() });
    pages.get(k).reasons.add(reason);
  };
  if (wPages.length) {
    const jobs = wPages.map((a) => ({ a, args: { query: a.name, page_size: 5, max_highlight_length: 0 } }));
    const ws = await collect(ctx, run, T('notion-search'), jobs, { pageOf: (j) => (Array.isArray(j.results) ? { items: j.results, next: null } : null), batch: 10, label: 'watched pages' });
    cost += ws.cost; listFailed.push(...ws.unfinished); unfinished.push(...ws.unfinished);
    let n = 0;
    for (const j of jobs) {
      const hit = (ws.results.get(ws.keyOf(j.args)) || []).find((h) => flat(h.id) === flat(j.a.id));
      if (hit && tsDay(hit.timestamp) >= startDate) { addPage(hit, 'watched_page'); n++; }
    }
    log(`watched pages: ${n} of ${wPages.length} edited since ${startDate} (their child pages are not walked)`);
  }
  if (wDbs.length) {
    const jobs = wDbs.map((a) => {
      const src = `collection://${a.data_source_id}`;
      return { a, args: { data: { data_source_urls: [src], query: `SELECT id, url, createdTime FROM "${src}" WHERE "createdTime" >= '${startDate}' ORDER BY "createdTime" DESC LIMIT 100` } } };
    });
    const wq = await collect(ctx, run, T('notion-query-data-sources'), jobs, { pageOf: (j) => (Array.isArray(j.results) ? { items: j.results, next: null } : null), batch: 5, label: 'watched databases' });
    cost += wq.cost; listFailed.push(...wq.unfinished); unfinished.push(...wq.unfinished);
    for (const j of jobs) {
      const rows = wq.results.get(wq.keyOf(j.args)) || [];
      for (const row of rows) if (row.id) addPage({ id: row.id, url: row.url, createdTime: `${String(row.createdTime || '').slice(0, 10)}` }, 'watched_db_row');
      log(`watched database "${j.a.name}": ${rows.length} row(s) created since ${startDate}${rows.length >= 100 ? ' (hit the 100-row limit)' : ''}`);
    }
  }
  const pendingIn = readPending(vault, 'notion');
  for (const p of pendingIn) if (!pages.has(flat(p.id))) pages.set(flat(p.id), { ...p, reasons: new Set(p.reasons || []) });
  log(`${pages.size} page(s) in scope${pendingIn.length ? ` (incl. pending from an earlier run)` : ''}`);

  // 2. Detail: body + comments, every page.
  const ids = [...pages.keys()];
  const fe = await collect(ctx, run, T('notion-fetch'), ids.map((id) => ({ args: { id } })), { pageOf: (j) => (j && (j.text || j.metadata) ? { items: [j], next: null } : null), batch: 20, label: 'fetch' });
  const gc = await collect(ctx, run, T('notion-get-comments'), ids.map((id) => ({ args: { page_id: id, include_all_blocks: true } })), { pageOf: (j) => (j && !j.error && (typeof j.text === 'string' || 'suggested_edits_status' in j) ? { items: [{ text: j.text || '' }], next: null } : null), batch: 20, label: 'comments' });
  cost += fe.cost + gc.cost; unfinished.push(...fe.unfinished, ...gc.unfinished);

  // 3. Render.
  const files = new Map();
  let maxEdited = wm || 0;
  for (const id of ids) {
    const meta = pages.get(id);
    const page = (fe.results.get(fe.keyOf({ id })) || [])[0];
    if (!page) continue;
    const comments = (gc.results.get(gc.keyOf({ page_id: id, include_all_blocks: true })) || [])[0];
    // No comments result means we don't know; writing "_No comments._" would
    // be a false claim in raw. Leave the page for the next run instead.
    // After COMMENT_TRIES runs with no result, write the page with a declared
    // placeholder instead of retrying it forever (one page did this 09-30 → 10-02).
    const gaveUp = !comments && (meta.attempts || 0) + 1 >= COMMENT_TRIES;
    if (!comments && !gaveUp) continue;
    const text = String(page.text || '');
    // A database row with no body comes back as <blank-page>; its properties
    // are the content, so an empty body is correct there.
    let body = (text.match(/<content>\n?([\s\S]*?)\n?<\/content>/) || [])[1];
    if (body === undefined && /<blank-page>/.test(text)) body = '';
    if (body === undefined) { unfinished.push(`fetch ${id}: no <content> block`); continue; }
    let props = {};
    try { props = JSON.parse((text.match(/<properties>\n?([\s\S]*?)\n?<\/properties>/) || [])[1] || '{}'); } catch {}
    const title = page.title || props.title || meta.title || 'Untitled';
    const ancestors = (text.match(/<ancestor-path>([\s\S]*?)<\/ancestor-path>/) || [])[1] || '';
    const parentDb = (ancestors.match(/<parent-database[^>]*title="([^"]*)"/) || ancestors.match(/<parent-data-source[^>]*name="([^"]*)"/) || [])[1] || null;
    const edited = page.page_last_edited_at || tsDay(meta.timestamp) || null;
    const t = Date.parse(edited); if (Number.isFinite(t) && t > maxEdited) maxEdited = t;
    const extraProps = Object.entries(props).filter(([k]) => k !== 'title');
    const fm = [
      '---',
      `notion_type: ${parentDb ? 'database_row' : 'page'}`,
      `notion_id: ${dashed(id)}`,
      `title: ${q(title)}`,
      `parent_type: ${parentDb ? 'database' : 'null'}`,
      'parent_id: null',
      `parent_database: ${q(parentDb)}`,
      'created_by: Unknown',
      'last_edited_by: Unknown',
      'created_time: null',
      `last_edited_time: ${q(edited)}`,
      `url: ${q(String(page.url || meta.url || '').replace(/\?pvs=\d+$/, ''))}`,
      extraProps.length ? 'properties:' : 'properties: {}',
      ...extraProps.map(([k, v]) => `  ${k}: ${JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v))}`),
      `in_scope_reasons: [${[...meta.reasons].sort().join(', ')}]`,
      // Notion itself cuts very large pages; say so rather than imply a full copy.
      ...(page.truncated ? ['truncated: true', `unknown_block_count: ${page.unknown_block_count || 0}`] : []),
      'tags:', '  - notion', `  - notion/${parentDb ? 'database_row' : 'page'}`,
      '---',
    ].join('\n');
    files.set(filenameFor(vault, id), `${fm}\n\n# ${title}\n\n${body.trim()}\n\n## Comments\n${gaveUp ? COMMENTS_UNFETCHED : renderComments(comments.text)}\n`);
  }
  log(`rendered ${files.size} page file(s); ${unfinished.length} unfinished`);
  for (const u of unfinished.slice(0, 8)) log(`gap: ${u}`);

  const { problems, notes } = verify(vault, src, { emitted: [...files.keys()] }, files, { since, today: now }, { modelAuthored: false });
  for (const n of notes) log(`note: ${n}`);
  for (const p of problems) log(`GATE: ${p}`);
  if (problems.length) return finish(run, 'error', `gate failed (${problems.length}); nothing written`, { problems }, cost);

  const { written, skipped } = commit(vault, files);
  // Pages listed but not rendered go to the ledger; only a failed search holds the watermark.
  const missing = ids.filter((id) => !files.has(filenameFor(vault, id)));
  writePending(vault, 'notion', missing.map((id) => { const m = pages.get(id); return { id, title: m.title, url: m.url, timestamp: m.timestamp, reasons: [...m.reasons], attempts: (m.attempts || 0) + 1 }; }));
  let moved = 'unchanged';
  if (listFailed.length) moved = `HELD (${listFailed.length} search call(s) unfinished)`;
  else if (maxEdited && (!wm || maxEdited > wm)) {
    fs.writeFileSync(path.join(vault, 'notion', '.last-sync'), `${new Date(maxEdited).toISOString()}\n`);
    moved = `→ ${new Date(maxEdited).toISOString().slice(0, 16)}Z`;
  }
  finish(run, missing.length || listFailed.length ? 'warn' : 'ok', `${written} written, ${skipped} unchanged · ${pages.size} pages · watermark ${moved}${missing.length ? ` · ${missing.length} page(s) pending for next run` : ''}`,
    { pages: pages.size, unfinished: unfinished.length }, cost);
}

module.exports = { syncNotionMcp, renderComments, filenameFor };
