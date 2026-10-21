// Notion sync through the claude.ai Notion connector. Same pattern as Slack
// and Linear: the runner decides every call, haiku presses the buttons, and
// code writes notion/pages/<uuid>.md from the raw results.
//
//   discover  notion-search with the spec's signals, unioned by page id:
//             last_edited_by me · created_by me · mentions (owner.name from config.yaml)
//             (search needs a non-empty query; sources.notion.search_terms
//             are the catch-alls, e.g. "the", "a" and the company name;
//             measured 2026-10-01: "*" returns nothing)
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
const { redact } = require('./redact');

const DAY = 86400000;
const COMMENT_TRIES = 3;
const COMMENTS_UNFETCHED = `_Comments not fetched: the connector returned no result in ${COMMENT_TRIES} consecutive runs._`;

// Meeting-note transcripts. notion-fetch returns a placeholder line inside the
// transcript section unless the call has include_transcript: true, so a
// meeting page is found by pass 1 and fetched again by pass 2:
//
//   pass 1 {id} ──▶ placeholder? ── no ──────────────────────────▶ render
//                       │ yes
//                       ├─ excluded (exclude_transcripts_for) ──────▶ render, placeholder kept
//                       ├─ raw has it, same edit time ─ reuse ──────▶ render
//                       └─ pass 2 {id, include_transcript} ─ ok ────▶ render
//                                                         └ none ─▶ pending (COMMENT_TRIES runs),
//                                                                   then old raw transcript or placeholder
// render: redact() secrets, then cut at max_transcript_chars with a marker.
// Nothing is dropped for being off-topic: relevance is ingest's job (raw-purity).
const TRANSCRIPT_RE = /(<meeting-notes-section-transcript>\n?)([\s\S]*?)(\n?<\/meeting-notes-section-transcript>)/g;
const OMITTED_RE = /^Transcript omitted\. To load it, fetch again with include_transcript/;
const CUT_RE = /\[truncated at (\d+) chars, full transcript at the url above\]$/;
const BACKFILL_PER_RUN = 10;
const TRANSCRIPT_BATCH = 3; // one transcript can be ~54k chars; 20 per context overflowed the plan

const transcriptsOf = (text) => [...String(text || '').matchAll(TRANSCRIPT_RE)].map((m) => m[2]);
const isOmitted = (t) => OMITTED_RE.test(String(t).trim());
const needsTranscript = (text) => transcriptsOf(text).some(isOmitted);
const mapTranscripts = (text, fn) => { let i = 0; return String(text).replace(TRANSCRIPT_RE, (m, a, t, b) => a + fn(t, i++) + b); };

// A declared cap, never a judgment: cut at the last line break at or under max.
function capTranscript(t, max) {
  if (t.length <= max || CUT_RE.test(t.trimEnd())) return { text: t, cut: CUT_RE.test(t.trimEnd()) };
  const nl = t.lastIndexOf('\n', max);
  return { text: `${t.slice(0, nl > 0 ? nl : max).trimEnd()}\n\n[truncated at ${max} chars, full transcript at the url above]`, cut: true };
}

// Redact and cap every fetched transcript in a page body. Placeholders stay
// as Notion wrote them. Safe to run twice on the same text.
function processTranscripts(body, max) {
  let cut = false, redacted = 0;
  const text = mapTranscripts(body, (t) => {
    if (isOmitted(t)) return t;
    const c = capTranscript(redact(t, () => { redacted++; }), max);
    cut = cut || c.cut;
    return c.text;
  });
  return { text, cut, redacted };
}

// The transcripts in an existing raw file, if they can stand in for a fetch:
// none is a placeholder, a cut one was cut at today's cap, and (when edited
// is given) the file has the same last_edited_time. Otherwise null.
function storedTranscripts(fileText, edited, max) {
  const ts = transcriptsOf(fileText);
  if (!ts.length || ts.some(isOmitted)) return null;
  if (ts.some((t) => { const m = t.trimEnd().match(CUT_RE); return m && Number(m[1]) !== max; })) return null;
  if (edited !== undefined && (fileText.match(/^last_edited_time: (.*)$/m) || [])[1] !== q(edited)) return null;
  return ts;
}

// The exclude_transcripts_for entry that matches a page (its id, or its
// parent database's title), or null.
function excludedBy(id, parentDb, list) {
  return (list || []).map(String).find((e) => (/^[0-9a-f]{32}$/i.test(flat(e)) ? flat(e).toLowerCase() === flat(id).toLowerCase() : parentDb !== null && e === parentDb)) || null;
}

// One-time backfill: raw pages synced before transcripts were fetched still
// hold the placeholder. Read only; the sync re-fetches them like any page.
// Skips pages that are excluded or that already gave up (transcript_fetched: false).
function backfillCandidates(vault, exclude) {
  const dir = path.join(vault, 'notion', 'pages');
  let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort(); } catch {}
  const out = [];
  for (const n of names) {
    let text; try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    if (!text.includes('Transcript omitted') || !needsTranscript(text)) continue;
    if (/^transcript_fetched: false$/m.test(text)) continue;
    const f = (k) => (text.match(new RegExp(`^${k}: (.*)$`, 'm')) || [])[1];
    const unq = (v) => { try { return JSON.parse(v); } catch { return null; } };
    const id = f('notion_id');
    if (!id) continue;
    if (excludedBy(id, unq(f('parent_database')), exclude)) continue;
    const reasons = String(f('in_scope_reasons') || '').replace(/[[\]\s]/g, '').split(',').filter(Boolean);
    out.push({ id, title: unq(f('title')), url: unq(f('url')), reasons });
  }
  return out;
}

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

// One page's raw file from its notion-fetch result. commentsText null means
// the comments were never fetched (declared placeholder). opts.maxTranscript
// turns on transcript redact + cap; opts.transcriptUnfetched marks a page
// written with Notion's placeholder after the transcript fetch kept failing.
// Returns { md, edited, cut, redacted } or { error } when there is no body.
function renderPage(id, meta, page, commentsText, opts = {}) {
  const text = String(page.text || '');
  // A database row with no body comes back as <blank-page>; its properties
  // are the content, so an empty body is correct there.
  let body = (text.match(/<content>\n?([\s\S]*?)\n?<\/content>/) || [])[1];
  if (body === undefined && /<blank-page>/.test(text)) body = '';
  if (body === undefined) return { error: 'no <content> block' };
  let cut = false, redacted = 0;
  if (opts.maxTranscript) ({ text: body, cut, redacted } = processTranscripts(body, opts.maxTranscript));
  let props = {};
  try { props = JSON.parse((text.match(/<properties>\n?([\s\S]*?)\n?<\/properties>/) || [])[1] || '{}'); } catch {}
  const title = page.title || props.title || meta.title || 'Untitled';
  const parentDb = parentDatabase(text);
  const edited = editedOf(page, meta);
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
    ...(cut ? ['transcript_truncated: true'] : []),
    ...(opts.transcriptUnfetched ? ['transcript_fetched: false'] : []),
    'tags:', '  - notion', `  - notion/${parentDb ? 'database_row' : 'page'}`,
    '---',
  ].join('\n');
  const md = `${fm}\n\n# ${title}\n\n${body.trim()}\n\n## Comments\n${commentsText === null ? COMMENTS_UNFETCHED : renderComments(commentsText)}\n`;
  return { md, edited, cut, redacted };
}

const editedOf = (page, meta) => page.page_last_edited_at || tsDay(meta.timestamp) || null;

// Which meeting pages need what. plan: id -> 'fetch' | 'reuse' | 'excluded'.
// hits: the exclusion keys that matched (for exclusions.report).
function planTranscripts(ids, pass1, rawOf, tx, metaOf) {
  const plan = new Map(), hits = new Set();
  for (const id of ids) {
    const p = pass1(id);
    if (!p || !needsTranscript(p.text)) continue;
    const ex = excludedBy(id, parentDatabase(p.text), tx.exclude);
    if (ex) { plan.set(id, 'excluded'); hits.add(`notion:transcript:${ex}`); continue; }
    const s = storedTranscripts(rawOf(id), editedOf(p, metaOf(id)), tx.max);
    plan.set(id, s && s.length === transcriptsOf(p.text).length ? 'reuse' : 'fetch');
  }
  return { plan, hits };
}

// The page to render for one id, given its plan state and pass-2 result.
// { page, state } to render; { hold: true } to leave it for the next run.
// After COMMENT_TRIES failed runs: the raw file's old transcript if it has
// one (a full transcript is never replaced by a placeholder), else Notion's
// placeholder with transcript_fetched: false.
function pickTranscriptPage(state, page, full, rawText, meta, max) {
  if (state === 'excluded') return { page, state: 'excluded' };
  if (state === 'reuse') {
    const ts = storedTranscripts(rawText, editedOf(page, meta), max);
    if (ts) return { page: { ...page, text: mapTranscripts(page.text, (t, i) => (i < ts.length ? ts[i] : t)) }, state: 'reused' };
    state = 'fetch';
  }
  if (state !== 'fetch') return { page };
  if (full && !needsTranscript(full.text)) return { page: full, state: 'fetched' };
  if ((meta.attempts || 0) + 1 < COMMENT_TRIES) return { hold: true };
  const old = storedTranscripts(rawText, undefined, max);
  if (old) return { page: { ...page, text: mapTranscripts(page.text, (t, i) => (i < old.length ? old[i] : t)) }, state: 'gaveUp' };
  return { page, state: 'gaveUp', unfetched: true };
}

function parentDatabase(text) {
  const ancestors = (String(text).match(/<ancestor-path>([\s\S]*?)<\/ancestor-path>/) || [])[1] || '';
  return (ancestors.match(/<parent-database[^>]*title="([^"]*)"/) || ancestors.match(/<parent-data-source[^>]*name="([^"]*)"/) || [])[1] || null;
}

async function syncNotionMcp(run, ctx) {
  const { vault, logLine, finish, src } = ctx;
  const log = (s) => logLine(run, s);
  const T = (name) => tool(vault, 'notion', name);
  // Notion search needs a query; common words find the owner's pages
  // (config.yaml sources.notion.search_terms; a company name works well).
  const CATCHALL = getConfig(vault).sources.notion.search_terms.map(String);
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

  // 1c. Transcript backfill (once): old raw pages that still hold Notion's placeholder.
  const nc = cfg.sources.notion;
  const tx = { on: nc.include_meeting_transcripts === true, max: nc.max_transcript_chars, exclude: nc.exclude_transcripts_for || [] };
  if (tx.on && nc.backfill_transcripts) {
    const cands = backfillCandidates(vault, tx.exclude).filter((c) => !pages.has(flat(c.id)));
    for (const c of cands.slice(0, BACKFILL_PER_RUN)) pages.set(flat(c.id), { id: c.id, title: c.title, url: c.url, timestamp: null, reasons: new Set(c.reasons) });
    log(cands.length ? `transcript backfill: ${Math.min(cands.length, BACKFILL_PER_RUN)} of ${cands.length} old meeting page(s) this run` : 'transcript backfill: done, no old page is missing its transcript');
  }

  // 2. Detail: body + comments, every page.
  const ids = [...pages.keys()];
  const fe = await collect(ctx, run, T('notion-fetch'), ids.map((id) => ({ args: { id } })), { pageOf: (j) => (j && (j.text || j.metadata) ? { items: [j], next: null } : null), batch: 20, label: 'fetch' });
  const gc = await collect(ctx, run, T('notion-get-comments'), ids.map((id) => ({ args: { page_id: id, include_all_blocks: true } })), { pageOf: (j) => (j && !j.error && (typeof j.text === 'string' || 'suggested_edits_status' in j) ? { items: [{ text: j.text || '' }], next: null } : null), batch: 20, label: 'comments' });
  cost += fe.cost + gc.cost; unfinished.push(...fe.unfinished, ...gc.unfinished);
  const pass1 = (id) => (fe.results.get(fe.keyOf({ id })) || [])[0];
  const rawOf = (id) => { try { return fs.readFileSync(path.join(vault, filenameFor(vault, id)), 'utf8'); } catch { return ''; } };

  // 2b. Transcripts: a second fetch, only for meeting pages that need one.
  const tplan = tx.on ? planTranscripts(ids, pass1, rawOf, tx, (id) => pages.get(id)) : { plan: new Map(), hits: new Set() };
  const want = ids.filter((id) => tplan.plan.get(id) === 'fetch');
  let tr = null;
  if (want.length) {
    tr = await collect(ctx, run, T('notion-fetch'), want.map((id) => ({ args: { id, include_transcript: true } })), { pageOf: (j) => (j && (j.text || j.metadata) ? { items: [j], next: null } : null), batch: TRANSCRIPT_BATCH, label: 'transcripts' });
    cost += tr.cost; unfinished.push(...tr.unfinished);
  }
  if (tx.on && tx.exclude.length) require('./exclusions').report(vault, tx.exclude.map((e) => `notion:transcript:${e}`), tplan.hits);
  const pass2 = (id) => (tr ? (tr.results.get(tr.keyOf({ id, include_transcript: true })) || [])[0] : undefined);
  const tcount = { meeting: tplan.plan.size, fetched: 0, reused: 0, excluded: 0, held: 0, gaveUp: 0, cut: 0, redacted: 0 };

  // 3. Render.
  const files = new Map();
  let maxEdited = wm || 0;
  for (const id of ids) {
    const meta = pages.get(id);
    let page = pass1(id);
    if (!page) continue;
    const comments = (gc.results.get(gc.keyOf({ page_id: id, include_all_blocks: true })) || [])[0];
    // No comments result means we don't know; writing "_No comments._" would
    // be a false claim in raw. Leave the page for the next run instead.
    // After COMMENT_TRIES runs with no result, write the page with a declared
    // placeholder instead of retrying it forever (one page did this 09-30 → 10-02).
    const gaveUp = !comments && (meta.attempts || 0) + 1 >= COMMENT_TRIES;
    if (!comments && !gaveUp) continue;
    const pick = pickTranscriptPage(tplan.plan.get(id), page, pass2(id), rawOf(id), meta, tx.max);
    if (pick.hold) { tcount.held++; continue; }
    page = pick.page;
    if (pick.state) tcount[pick.state]++;
    const r = renderPage(id, meta, page, gaveUp ? null : comments.text, tx.on ? { maxTranscript: tx.max, transcriptUnfetched: pick.unfetched } : {});
    if (r.error) { unfinished.push(`fetch ${id}: ${r.error}`); continue; }
    if (r.cut) tcount.cut++;
    tcount.redacted += r.redacted || 0;
    const t = Date.parse(r.edited); if (Number.isFinite(t) && t > maxEdited) maxEdited = t;
    files.set(filenameFor(vault, id), r.md);
  }
  if (tx.on && tcount.meeting) log(`transcripts: ${tcount.meeting} meeting page(s) · ${tcount.fetched} fetched · ${tcount.reused} unchanged (no fetch) · ${tcount.excluded} excluded · ${tcount.held} held for next run · ${tcount.gaveUp} written without (gave up) · ${tcount.cut} cut at ${tx.max} chars · ${tcount.redacted} credential(s) redacted`);
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

module.exports = {
  syncNotionMcp, renderComments, renderPage, filenameFor,
  needsTranscript, capTranscript, processTranscripts, storedTranscripts, excludedBy, backfillCandidates, planTranscripts, pickTranscriptPage,
};
