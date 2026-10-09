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

const DAY = 86400000;
const WINDOW_DAYS = 4; // default rolling window; a source can override with windowDays

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
// "### " heading. Bots run with no setting sources, which does NOT load the
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

function shortInput(input) {
  const s = JSON.stringify(input || {});
  return s.length > 110 ? `${s.slice(0, 107)}…` : s;
}

// Content check, borrowed from linkrot-lint section 6. These shapes are a
// sync agent standing in for content it didn't fetch ("35-reply thread",
// "(see Mentions)"), which the gate blocks. The italic `_(...)_` form is only
// logged: the owner's own messages sometimes use it, so it's too noisy to block on.
const STANDIN_RE = /\((see|captured|full thread) (Sent|Mentions|above|below)|[0-9]+-reply thread|[0-9]+\+? (more|further|remaining) (replies|messages)/;
const ITALIC_RE = /_\([^)]{8,}\)_/;

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

module.exports = { SOURCES, specSection, rulesSection, shortInput, verify, commit, rangeFor };
