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
const WINDOW_DAYS = 4; // default rolling window; a caller can pass src.windowDays

// The five sources the app syncs. Each sync is code-backed (lib/<key>-mcp.js):
// the model only presses the connector's buttons and code writes raw.
// dayFiles = one file per day under dir/ (the verify gate checks every day).
const SOURCES = {
  slack: { name: 'Slack', dir: 'slack', dayFiles: true },
  gcal: { name: 'Calendar', dir: 'gcal', dayFiles: true },
  gdrive: { name: 'Drive', dir: 'gdrive' },
  notion: { name: 'Notion', dir: 'notion' },
  linear: { name: 'Linear', dir: 'linear' },
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
// Every raw file a sync wrote (or found identical) goes in the raw ledger
// with its hash, so Verify can flag a raw file that changed outside a sync,
// e.g. a chat session's Bash edit (OV-c).
const LEDGER = (vault) => path.join(vault, '.bot', 'state', 'raw-ledger.json');
function readLedger(vault) { try { return JSON.parse(fs.readFileSync(LEDGER(vault), 'utf8')); } catch { return {}; } }

function commit(vault, files) {
  let written = 0, skipped = 0;
  const ledger = readLedger(vault);
  for (const [rel, text] of files) {
    const abs = path.resolve(vault, rel);
    let old = null; try { old = fs.readFileSync(abs, 'utf8'); } catch {}
    const h = sha(text);
    ledger[rel] = h;
    if (old !== null && sha(old) === h) { skipped++; continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    written++;
  }
  try { fs.mkdirSync(path.dirname(LEDGER(vault)), { recursive: true }); fs.writeFileSync(LEDGER(vault), JSON.stringify(ledger)); } catch {}
  return { written, skipped };
}

// Raw files whose content no longer matches what a sync last wrote.
// projects/ is not here: Claude Code's auto-memory writes it by design.
function rawChangedOutsideSync(vault) {
  const out = [];
  for (const [rel, h] of Object.entries(readLedger(vault))) {
    let text; try { text = fs.readFileSync(path.join(vault, rel), 'utf8'); } catch { continue; }
    if (sha(text) !== h) out.push(rel);
  }
  return out;
}

module.exports = { SOURCES, specSection, rulesSection, shortInput, verify, commit, rangeFor, rawChangedOutsideSync };
