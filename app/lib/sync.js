// Sync bots: one per source. Each run is a single `claude -p` (sonnet) in the
// vault, following that source's "Sync (...)" op in the vault's CLAUDE.md.
//
// Division of labour (the plan's invariant: the model fetches and writes,
// the runner decides):
//
//   model                                   runner (this file)
//   ─────                                   ──────────────────
//   fetch from the source (read-only tools) computes the date range
//   write raw files in its own dir          streams every tool call into the log
//   ends with MANIFEST: {...}               checks each WRITTEN file landed (mtime > start)
//                                           checks in-window day files (slack, gcal)
//                                           ONLY THEN writes <source>/.last-sync
//
// Headless runtime notes (measured 2026-10-01): plugin MCP tools never load
// under `claude -p`, so the spec's mcp__plugin_* names are swapped for the
// claude.ai connector names below.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DAY = 86400000;
const WINDOW_DAYS = 4; // default rolling window; a source can override with windowDays

// jq is for reading the big tool results the CLI spills to disk. No python:
// it can write anywhere, which would make the Write(<dir>/**) scope meaningless.
const READ_ONLY_BASH = ['date', 'shasum', 'stat', 'ls', 'wc', 'jq', 'head'].map((c) => `Bash(${c}:*)`);

const SOURCES = {
  slack: {
    name: 'Slack',
    section: 'Sync (Slack)',
    dir: 'slack',
    dayFiles: true,
    // Per chunk. $4 for an 11-day single run was too small (2026-10-01), and
    // $12 still dropped days; 4-day chunks keep each run the size of a normal
    // daily sync.
    budget: 5,
    chunkDays: 3,
    windowDays: 2, // vault spec, 2026-10-01: lean daily Slack
    // Haiku was tried and can't follow this spec (2026-10-01: 19 tool calls,
    // no thread expansion, no MANIFEST, tried to emit .last-sync). Sonnet only.
    rename: 'Wherever the spec names a tool mcp__plugin_slack_slack__<tool>, call mcp__claude_ai_Slack__<tool> instead.',
    // Each line answers a shortcut the first run actually took.
    extra: [
      'Run BOTH searches from step 3, sent messages AND mentions, across the whole range. Both are mandatory.',
      'Step 4: call slack_read_thread for every root with replies, then follow the posted-vs-mention-only rule in step 4 exactly. Full thread where the owner posted; root + mention + last 5 replies plus the exact declared placeholder line where they did not. Never write a reply count or summary in place of replies.',
      'Write a file for EVERY day in the range, even a quiet one (use the declared placeholder _No messages._ under each empty section). Always rewrite from source; never keep an existing file because it looks richer.',
      'Search pages are large: request the fewest fields the spec allows and paginate to exhaustion. If you get page_limit_exceeded, split the range into smaller date windows rather than stopping.',
      'Declared exception to verbatim: if a message contains a password, API key or token, write [credential redacted by sync] in its place, and list the permalink in gaps.',
    ].join(' '),
    tools: ['slack_search_public_and_private', 'slack_read_thread', 'slack_read_channel', 'slack_read_user_profile', 'slack_search_users']
      .map((t) => `mcp__claude_ai_Slack__${t}`),
  },
  gcal: {
    name: 'Calendar',
    section: 'Sync (Google Calendar)',
    also: ['Sensitivity denylist (Google sources)'],
    dir: 'gcal',
    dayFiles: true,
    budget: 2,
    rename: 'Tool names in the spec are already correct for this runtime (mcp__claude_ai_Google_Calendar__*).',
    tools: ['list_calendars', 'list_events', 'get_event'].map((t) => `mcp__claude_ai_Google_Calendar__${t}`),
  },
  gdrive: {
    name: 'Drive',
    section: 'Sync (Google Drive)',
    also: ['Sensitivity denylist (Google sources)'],
    dir: 'gdrive',
    // $3 ran out with 6 files unfetched on 2026-10-01 (bodies are big).
    budget: 5,
    rename: 'Tool names in the spec are already correct for this runtime (mcp__claude_ai_Google_Drive__*).',
    tools: ['search_files', 'list_recent_files', 'get_file_metadata', 'read_file_content'].map((t) => `mcp__claude_ai_Google_Drive__${t}`),
  },
  notion: {
    name: 'Notion',
    section: 'Sync (Notion)',
    dir: 'notion',
    budget: 6,
    rename: 'Wherever the spec names a tool mcp__plugin_Notion_notion__<tool>, call mcp__claude_ai_Notion__<tool> instead.',
    tools: ['notion-search', 'notion-fetch', 'notion-get-comments', 'notion-query-data-sources', 'notion-get-users']
      .map((t) => `mcp__claude_ai_Notion__${t}`),
  },
  linear: {
    name: 'Linear',
    section: 'Sync (Linear)',
    dir: 'linear',
    budget: 8,
    rename: 'Wherever the spec names a tool mcp__plugin_linear_linear__<tool> or mcp__claude_ai_Linear__<tool>, call mcp__claude_ai_Linear__<tool>.',
    extra: 'Reuse linear/.initiative-scope.json as-is even if it is older than 7 days (a rescope is a separate run). If its project_count is below 150, stop and report that in gaps instead of syncing.',
    tools: ['list_projects', 'get_project', 'list_issues', 'get_issue', 'list_comments', 'get_initiative', 'list_documents', 'get_document']
      .map((t) => `mcp__claude_ai_Linear__${t}`),
  },
};

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Pull one "### <title>" section out of the vault's CLAUDE.md, up to the next
// "### " heading. Bots run with --setting-sources user, which does NOT load the
// project CLAUDE.md, so the op spec is handed over in the prompt instead. That
// is also ~10x fewer tokens than the whole 1000-line file.
function specSection(vault, title) {
  const text = fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`### ${title}`));
  if (start < 0) throw new Error(`CLAUDE.md has no "### ${title}" section`);
  let end = lines.findIndex((l, i) => i > start && (l.startsWith('### ') || l.startsWith('## Rules')));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trim();
}

function rulesSection(vault) {
  const text = fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8');
  const i = text.indexOf('\n## Rules');
  return i < 0 ? '' : text.slice(i + 1).trim();
}

function readWatermark(vault, src) {
  try {
    const t = Date.parse(fs.readFileSync(path.join(vault, src.dir, '.last-sync'), 'utf8').trim());
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

// Range = MIN(window start, watermark), through today. Computed here, not by
// the model, so a run can't quietly pick its own window.
function rangeFor(vault, src, nowMs) {
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  const windowStart = today - ((src.windowDays || WINDOW_DAYS) - 1) * DAY;
  const wm = readWatermark(vault, src);
  const since = wm ? Math.min(windowStart, Date.UTC(new Date(wm).getUTCFullYear(), new Date(wm).getUTCMonth(), new Date(wm).getUTCDate())) : windowStart;
  return { since, today, windowStart, watermark: wm };
}

function promptFor(vault, src, startIso, range) {
  const spec = [src.section, ...(src.also || [])].map((t) => specSection(vault, t)).join('\n\n');
  return [
    `You are the vault's ${src.name} sync bot, running unattended. Your working directory is the vault root.`,
    `Do the "${src.section}" operation below exactly as written, every step and every rule, with these overrides:`,
    `- Time: START is ${startIso}. Treat it as "now"; do not run date to derive a different one.`,
    `- Range: fetch ${isoDay(range.since)} through ${isoDay(range.today)} inclusive (UTC). This already accounts for the rolling window and the watermark.`,
    `- Tools: this is a headless runtime. ${src.rename} Load schemas with ToolSearch.`,
    '- YOU CANNOT WRITE FILES. You have no Write/Edit tools. To write a file, put its COMPLETE content in your reply text as a block, exactly like this:',
    `    <<<FILE ${src.dir}/<path>`,
    '    <the full file content, verbatim>',
    '    <<<END>>>',
    '  Emit each block as soon as you have that file\'s content, in the same message as your next tool call. Do not save them all for the end: a single message has an output limit. Emit a file once; if you must correct it, emit it again and the last copy wins. The runner checks every block and writes them only if the whole run passes, and it does the content-hash skip itself, so emit every in-scope file even if you think it is unchanged.',
    `- Every block path must be inside ${src.dir}/. Include state files the op maintains (e.g. ${src.dir}/.state.json) as blocks too. Never emit ${src.dir}/.last-sync, wiki/log.md or anything outside ${src.dir}/; the runner owns the watermark.`,
    '- RAW PURITY and NO ANNOTATIONS IN RAW apply to every block.',
    '- Read only: never send, post, create, update or delete anything in any source system. Bash is limited to read-only helpers (jq, head, ls, stat, wc, shasum, date).',
    src.extra ? `- ${src.extra}` : '',
    'Finish your reply with exactly one line, and nothing after it:',
    'MANIFEST: {"complete":<true only if you fetched EVERY in-scope item for the range; false if anything was left unfetched for any reason>,"emitted":["<every path you emitted a FILE block for>"],"max_ts":"<newest source timestamp seen, ISO-8601 UTC>","counts":{"<name>":<n>},"gaps":["<anything you could not fetch or finish>"]}',
    '',
    '================ THE OPERATION (from the vault CLAUDE.md) ================',
    spec,
    '',
    '================ VAULT RULES (from the vault CLAUDE.md) ================',
    rulesSection(vault),
  ].filter((l) => l !== null && l !== undefined && l !== false).join('\n');
}

function shortInput(input) {
  const s = JSON.stringify(input || {});
  return s.length > 110 ? `${s.slice(0, 107)}…` : s;
}

// Run claude with stream-json so each tool call shows up in the board's log
// as it happens. Resolves with the final result event.
function claudeStream(claudeBin, args, { cwd, env, timeoutMs, onEvent }) {
  return new Promise((resolve) => {
    const child = spawn(claudeBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', result = null, err = '';
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'result') result = ev; else onEvent(ev);
      }
    });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, result, stderr: err.slice(-2000) }); });
  });
}

function parseManifest(text) {
  const m = String(text || '').match(/MANIFEST:\s*(\{[\s\S]*\})\s*$/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Content check, borrowed from linkrot-lint section 6. These shapes are a
// sync agent standing in for content it didn't fetch ("35-reply thread",
// "(see Mentions)"), which the gate blocks. The italic `_(...)_` form is only
// logged: the owner's own messages sometimes use it, so it's too noisy to block on.
const STANDIN_RE = /\((see|captured|full thread) (Sent|Mentions|above|below)|[0-9]+-reply thread|[0-9]+\+? (more|further|remaining) (replies|messages)/;
const ITALIC_RE = /_\([^)]{8,}\)_/;

const FILE_RE = /<<<FILE ([^\n]+)\n([\s\S]*?)\n?<<<END>>>/g;

// Collect every FILE block the model emitted across the whole run. Last copy
// of a path wins, so the model can correct a file by re-emitting it.
function collectFiles(texts) {
  const files = new Map();
  for (const t of texts) for (const m of t.matchAll(FILE_RE)) files.set(m[1].trim().replace(/^\.\//, ''), m[2].endsWith('\n') ? m[2] : `${m[2]}\n`);
  return files;
}

// The verification gate, run on the emitted files BEFORE anything touches
// disk. Returns { problems, notes }; no problems = pass.
// opts.modelAuthored=false: the files were rendered by code from raw tool
// results, so every word is source text and the stand-in check doesn't
// apply (people genuinely write "(see above)" in Slack, 2026-10-01).
function verify(vault, src, manifest, files, range, opts = {}) {
  const problems = [], notes = [];
  const root = path.join(vault, src.dir) + path.sep;
  for (const rel of files.keys()) {
    const abs = path.resolve(vault, rel);
    if (!abs.startsWith(root)) problems.push(`block outside ${src.dir}/: ${rel}`);
    if (rel === `${src.dir}/.last-sync`) problems.push(`block for the watermark file: ${rel} (runner-owned)`);
  }
  for (const rel of manifest.emitted || []) if (!files.has(rel)) problems.push(`manifest lists ${rel} but no FILE block for it`);
  if (src.dayFiles) {
    // Every day in the range must be emitted, quiet days included (they get a
    // declared placeholder), so a missing day always means the work wasn't done.
    for (let d = range.since; d <= range.today; d += DAY) {
      const rel = `${src.dir}/${isoDay(d)}.md`;
      if (!files.has(rel)) problems.push(`day file not emitted: ${rel}`);
    }
  }
  for (const [rel, text] of files) {
    if (!rel.endsWith('.md') || opts.modelAuthored === false) continue;
    const m = text.match(STANDIN_RE);
    if (m) problems.push(`stand-in for missing content in ${rel}: "${m[0]}"`);
    if (ITALIC_RE.test(text)) notes.push(`italic gloss shape in ${rel} (logged, not blocking)`);
  }
  return { problems, notes };
}

const sha = (t) => require('crypto').createHash('sha256').update(t).digest('hex');

// Gate passed: write the files. Content-hash skip lives here now, so an
// unchanged file keeps its mtime and ingest won't see it as new.
function commit(vault, files) {
  let written = 0, skipped = 0;
  for (const [rel, text] of files) {
    const abs = path.resolve(vault, rel);
    let old = null; try { old = fs.readFileSync(abs, 'utf8'); } catch {}
    if (old !== null && sha(old) === sha(text)) { skipped++; continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    written++;
  }
  return { written, skipped };
}

// One claude run over one date range. The model gets NO write tools: it
// emits FILE blocks and the runner writes them. Measured 2026-10-01: with
// Edit(<dir>/**) granted, real sync runs still had writes denied by a rule
// that never reproduced in isolation (5 tries). Taking file writes away from
// the model removes that whole class of failure, and puts the "only inside
// its own folder" rule in code instead of in permission patterns.
async function runOnce(run, ctx, src, range, budget) {
  const { claudeBin, vault, env, logLine } = ctx;
  const startIso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const tools = ['ToolSearch', 'Read', 'Glob', 'Grep', ...READ_ONLY_BASH, ...src.tools];
  let toolCalls = 0, blocks = 0;
  const texts = [];
  const r = await claudeStream(claudeBin, [
    '-p', promptFor(vault, src, startIso, range),
    '--model', src.model || 'sonnet',
    '--output-format', 'stream-json', '--verbose',
    '--allowedTools', tools.join(','),
    '--disallowedTools', 'Agent,Task,Write,Edit,NotebookEdit',
    // No --permission-mode override: the owner's auto mode stays in force
    // inside bots. Bots no longer write files (the runner does), so the
    // classifier has no writes to veto. dontAsk was removed 2026-10-01 after
    // the classifier rightly flagged it as bypassing auto mode.
    '--permission-prompts', 'none',
    // Only user settings: the vault's own .claude/settings.local.json allows
    // python3 and more, and project settings ADD to --allowedTools rather than
    // being replaced by it (seen on the first Calendar run, 2026-10-01).
    '--setting-sources', 'user',
    '--max-budget-usd', String(budget),
    '--no-session-persistence',
  ], {
    cwd: vault, env, timeoutMs: 45 * 60000,
    onEvent: (ev) => {
      if (ev.type !== 'assistant') return;
      for (const part of (ev.message && ev.message.content) || []) {
        if (part.type === 'text' && part.text) {
          texts.push(part.text);
          for (const m of part.text.matchAll(FILE_RE)) { blocks++; logLine(run, `▣ ${m[1].trim()} (${m[2].length} chars)`); }
        }
        if (part.type !== 'tool_use') continue;
        toolCalls++;
        logLine(run, `→ ${part.name.replace(/^mcp__claude_ai_[A-Za-z_]+__/, '')} ${shortInput(part.input)}`);
      }
    },
  });
  const p = r.result;
  if (!p) return { cost: 0, problems: [`claude exited ${r.code} with no result`], toolCalls };
  const cost = p.total_cost_usd || 0;
  if (p.subtype === 'error_max_budget_usd') return { cost, problems: [`hit the $${budget} budget after ${toolCalls} tool calls; nothing written`], toolCalls };
  // The final result text is also the last assistant message; dedupe by
  // collecting into a Map (last copy wins) rather than counting twice.
  const files = collectFiles([...texts, p.result || '']);
  const manifest = parseManifest(p.result);
  if (!manifest) return { cost, problems: ['no MANIFEST line in the reply; nothing written'], toolCalls };

  const { problems, notes } = verify(vault, src, manifest, files, range);
  for (const d of p.permission_denials || []) {
    const i = d.tool_input || {};
    notes.push(`denied ${d.tool_name}: ${shortInput(i.file_path || i.command || i)}`);
  }
  const deniedSource = [...new Set((p.permission_denials || []).map((d) => d.tool_name).filter((t) => t.startsWith('mcp__')))];
  if (deniedSource.length) problems.push(`source tools denied: ${deniedSource.join(', ')}`);
  if (!files.size && !(manifest.gaps || []).length) notes.push('no files emitted and no gaps reported');
  if (problems.length) return { cost, manifest, problems, notes, toolCalls, emitted: files.size };

  const { written, skipped } = commit(vault, files);
  logLine(run, `committed: ${written} written, ${skipped} unchanged (hash skip)`);
  return { cost, manifest, problems, notes, toolCalls, emitted: files.size, written, skipped };
}

// Split a long catch-up into sequential windows, so one run never has to hold
// 11 days of Slack (measured 2026-10-01: an 11-day single run spent $10.57 and
// still dropped days). Sequential, not parallel: no two agents race a file.
function chunksOf(range, days) {
  if (!days) return [range];
  const out = [];
  for (let s = range.since; s <= range.today; s += days * DAY) {
    out.push({ ...range, since: s, today: Math.min(range.today, s + (days - 1) * DAY) });
  }
  return out;
}

async function runSync(run, ctx, key) {
  const { vault, logLine, finish } = ctx;
  const src = SOURCES[key];
  const range = rangeFor(vault, src, Date.now());
  const chunks = chunksOf(range, src.chunkDays);
  logLine(run, `range ${isoDay(range.since)} → ${isoDay(range.today)}  (watermark ${range.watermark ? new Date(range.watermark).toISOString() : 'none'})`);
  logLine(run, `model ${src.model || 'sonnet'} · ${chunks.length} chunk(s) · budget $${src.budget} each`);

  let cost = 0, written = 0, maxTs = null, toolCalls = 0, allComplete = true;
  const gaps = [], counts = {};
  for (const [i, ch] of chunks.entries()) {
    if (chunks.length > 1) logLine(run, `── chunk ${i + 1}/${chunks.length}: ${isoDay(ch.since)} → ${isoDay(ch.today)}`);
    const r = await runOnce(run, ctx, src, ch, src.budget);
    cost += r.cost; toolCalls += r.toolCalls; written += r.written || 0;
    for (const n of r.notes || []) logLine(run, `note: ${n}`);
    if (r.manifest) {
      for (const g of r.manifest.gaps || []) { gaps.push(g); logLine(run, `gap: ${g}`); }
      for (const [k, v] of Object.entries(r.manifest.counts || {})) counts[k] = (typeof v === 'number' ? (counts[k] || 0) + v : v);
      if (r.manifest.complete !== true) allComplete = false;
      const t = Date.parse(r.manifest.max_ts);
      if (Number.isFinite(t) && (!maxTs || t > maxTs)) maxTs = t;
    }
    for (const pr of r.problems) logLine(run, `GATE: ${pr}`);
    if (r.problems.length) {
      // Stop at the first failed chunk: later chunks would be wasted spend,
      // and the watermark can't move past a hole anyway.
      return finish(run, 'error', `chunk ${i + 1}/${chunks.length} failed the gate (${r.problems.length}); its files NOT written, watermark NOT moved`,
        { range, chunk: i + 1, problems: r.problems, toolCalls }, cost);
    }
  }

  // Every chunk passed: the runner, not the model, moves the watermark. Forward
  // only, and only if every chunk says it fetched everything. The verified
  // files are kept either way; an incomplete run just leaves the watermark
  // where it was, so the next run still reaches the items it missed.
  // (2026-10-01: Drive ran out of budget with 6 files unfetched and said so in
  // prose only; the runner moved the watermark past them.)
  let moved = 'unchanged';
  if (!allComplete) moved = 'HELD (run reported incomplete)';
  else if (maxTs && (!range.watermark || maxTs > range.watermark)) {
    fs.writeFileSync(path.join(vault, src.dir, '.last-sync'), `${new Date(maxTs).toISOString().replace(/\.\d+Z$/, 'Z')}\n`);
    moved = `→ ${new Date(maxTs).toISOString().slice(0, 16)}Z`;
  }
  const c = Object.entries(counts).filter(([, v]) => typeof v === 'number').slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ');
  finish(run, gaps.length || !allComplete ? 'warn' : 'ok', `${written} written${c ? ` (${c})` : ''} · watermark ${moved}${gaps.length ? ` · ${gaps.length} gap(s)` : ''}`,
    { range, chunks: chunks.length, counts, gaps, toolCalls }, cost);
}

module.exports = { SOURCES, runSync, specSection, rulesSection, claudeStream, shortInput, collectFiles, verify, commit, rangeFor };
