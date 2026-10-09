// Ingest bot: fold new raw files into wiki pages, following the "Ingest" op
// from the vault's CLAUDE.md. Rebuilt 2026-10-01 after an audit of the first
// two runs found they read only the top of each big Slack day, skipped changed
// Drive files as "already cited", and still passed every gate.
//
//   runner                                        model (sonnet, per part)
//   ──────                                        ─────
//   delta-walk.sh --list (+ held ledger, + explicit files)
//   − sources whose latest sync failed (held)
//   − mechanical skips: wiki_ingest:false, pointer index, empty,
//     content date before the last ingest      (never "already cited")
//   split every file into entries [E#]
//   (Slack: one per message/thread), pack
//   into parts of ~45KB, text INLINE ─────────▶  grep the wiki, then APPEND / EDIT / FILE
//                                                 MANIFEST: every [E#] → pages | skip reason
//   per-part gate: every entry accounted for, every claimed page has an
//     applied block, no rewrite of an existing page, new pages in index.md
//   misses → one retry in the same session with the failures listed
//   pass → write pages + stamp sources:/updated: from the manifest (code, not model)
//   ALL parts pass → log.md entry → wiki/.last-ingest = START
//
// Parts that passed are remembered by content hash (.bot/state/ingest-progress.json),
// so a failed or budget-stopped run resumes where it stopped instead of
// re-appending the same sections.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { specSection, rulesSection, claudeStream, shortInput } = require('./sync');
const { readOwner, getConfig } = require('./config');
const { script } = require('./kit');
const { dayOf } = require('./time');
const { route, groupParts } = require('./route');
const { linearTiers } = require('./tiers');
const { addToIndex } = require('./wiki-index');

const PART_BUDGET = 3;      // $ per part (one claude -p call + its retry)
const RUN_BUDGET = 40;      // $ for the whole run; stop starting parts past this
const PART_BYTES = 45000;   // inline text per part
const CONCURRENCY = 3;

function wikiConventions(vault) {
  const text = fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8');
  const a = text.indexOf('\n## Wiki structure');
  const b = text.indexOf('\n## Operations');
  return a >= 0 && b > a ? text.slice(a + 1, b).trim() : '';
}

function deltaWalk(vault) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [script('delta-walk.sh'), '--vault', vault, '--list'], { cwd: vault, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', (code) => {
      const deltasLine = (out.match(/^Deltas walked:[^\n]*/m) || [''])[0];
      const files = (out.split('--- delta files ---')[1] || '').split('\n').map((s) => s.trim()).filter(Boolean);
      resolve({ code, deltasLine, files, raw: out });
    });
  });
}

// --- frontmatter -------------------------------------------------------------

function splitFrontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? { fm: m[1], body: text.slice(m[0].length) } : { fm: null, body: text };
}

const fmField = (fm, key) => {
  const m = fm && fm.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
};

// Append sources (keeping every existing entry) and set updated:. Handles both
// the YAML-list and the inline-array form; an inline array is rewritten as a list.
function stampFrontmatter(text, sources, date) {
  const { fm, body } = splitFrontmatter(text);
  if (fm === null) return text;
  const lines = fm.split('\n');
  let i = lines.findIndex((l) => /^sources:/.test(l));
  let have = [];
  if (i < 0) { lines.push('sources:'); i = lines.length - 1; }
  const inline = lines[i].match(/^sources:\s*\[(.*)\]\s*$/);
  if (inline) {
    have = inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    lines.splice(i, 1, 'sources:', ...have.map((s) => `  - ${s}`));
  }
  let end = i + 1;
  while (end < lines.length && /^\s+-\s/.test(lines[end])) end++;
  have = lines.slice(i + 1, end).map((l) => l.replace(/^\s+-\s*/, '').replace(/^["']|["']$/g, '').trim());
  const add = sources.filter((s) => !have.includes(s));
  lines.splice(end, 0, ...add.map((s) => `  - ${s}`));
  const u = lines.findIndex((l) => /^updated:/.test(l));
  if (u >= 0) lines[u] = `updated: ${date}`; else lines.push(`updated: ${date}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

// --- runner-side skips --------------------------------------------------------

// Only mechanical reasons. "Already cited" is not one: a changed file that a
// page already cites is exactly the file whose new content is missing. A
// content DATE is not one either: Linear sat unsynced at 09-04 for weeks, so
// its September issues landed after the last ingest with September dates
// (2026-10-01). What counts is whether these exact bytes were ingested before,
// which the ingested-hash ledger answers.
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function runnerSkip(vault, rel, ingested) {
  let text;
  try { text = fs.readFileSync(path.join(vault, rel), 'utf8'); } catch { return 'file is gone'; }
  if (path.basename(rel) === 'MEMORY.md') return 'pointer index';
  const { fm, body } = splitFrontmatter(text);
  if (fm && /^wiki_ingest:\s*false\s*$/m.test(fm)) return 'wiki_ingest: false';
  if (body.replace(/\s+/g, '').length < 20) return 'empty';
  if (ingested && ingested[rel] === sha(text)) return 'unchanged since it was last ingested (same content hash)';
  return null;
}

// Linear link-only tier (config.yaml linear.deep_initiatives): these files
// stay in raw for search, but are never ingested. Anything naming the owner
// (assignee, mention, comment) stays deep wherever it lives.
function linearLinkOnly(rel, text, tiers, ownerName) {
  if (!tiers.configured || !rel.startsWith('linear/')) return false;
  if (ownerName && text.includes(ownerName)) return false;
  const { fm } = splitFrontmatter(text);
  const f = (k) => { const v = fmField(fm, k); return v && v !== 'null' ? v : null; };
  if (rel.startsWith('linear/issues/')) return !(f('project') && tiers.isDeepProject(f('project')));
  if (rel.startsWith('linear/projects/')) return !(tiers.isDeepProject(f('linear_id') || '') || tiers.isDeepProject(f('title') || ''));
  if (rel.startsWith('linear/initiatives/')) return !tiers.isDeepInitiative(f('linear_id'));
  if (rel.startsWith('linear/docs/')) return !(f('project') && tiers.isDeepProject(f('project')));
  return false;
}

// --- snapshots and diffs ----------------------------------------------------
// A copy of each Notion / Linear / Drive file as it was when ingested. For big
// running documents someone else maintains (a Notion page that only MENTIONS
// the owner, over 10KB: meeting notes, pipeline reviews), the next ingest
// sends the model only what changed since that copy, not the whole page again.

const SNAP_CLASSES = ['notion/', 'linear/', 'gdrive/'];
const DIFF_MIN_BYTES = 10000;
const snapPath = (vault, rel) => path.join(vault, '.bot', 'state', 'ingested', `${crypto.createHash('sha1').update(rel).digest('hex')}.md`);

function diffEligible(rel, text) {
  if (!rel.startsWith('notion/') || text.length <= DIFF_MIN_BYTES) return false;
  const reasons = (fmField(splitFrontmatter(text).fm, 'in_scope_reasons') || '').replace(/[[\]\s]/g, '');
  return reasons === 'mentioned';
}

// Lines added since the snapshot (with 2 lines of context, in page order),
// then lines removed. Multiset line matching: linear time, no LCS, good enough
// for append-mostly documents. '' means the body did not change.
function changedOnly(oldText, newText) {
  const ob = splitFrontmatter(oldText).body.split('\n');
  const nb = splitFrontmatter(newText).body.split('\n');
  const pool = new Map();
  for (const l of ob) pool.set(l, (pool.get(l) || 0) + 1);
  const added = nb.map((l) => { const n = pool.get(l) || 0; if (n) { pool.set(l, n - 1); return false; } return l.trim() !== ''; });
  const removed = [];
  for (const [l, n] of pool) if (l.trim()) for (let i = 0; i < n; i++) removed.push(l);
  if (!added.some(Boolean) && !removed.length) return '';
  const keep = new Set();
  added.forEach((a, i) => { if (a) for (let j = Math.max(0, i - 2); j <= Math.min(nb.length - 1, i + 2); j++) keep.add(j); });
  const out = []; let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) { if (i > last + 1 && out.length) out.push('…'); out.push(nb[i]); last = i; }
  if (removed.length) out.push('', 'Lines removed since the last ingest:', ...removed.slice(0, 200).map((l) => `- ${l}`));
  return out.join('\n');
}

// --- link-only catalog page -------------------------------------------------
// wiki/initiatives/linear-catalog.md is rendered by code from linear/catalog.md,
// never by the model: it is a list of links, not synthesis.
function renderCatalogPage(vault, date) {
  let cat;
  try { cat = fs.readFileSync(path.join(vault, 'linear', 'catalog.md'), 'utf8'); } catch { return null; }
  const body = splitFrontmatter(cat).body.replace(/^# .*\n/, '').trim();
  const rel = 'wiki/initiatives/linear-catalog.md';
  const page = [
    '---', 'name: Linear catalog (link-only projects)', 'type: wiki', 'wiki_type: initiative', 'tags: []',
    'sources:', '  - linear/catalog.md', `updated: ${date}`, '---', '',
    '# Linear catalog (link-only projects)', '',
    '## Overview',
    'Projects in the Linear sync scope that are tracked here as links only (config.yaml `linear.deep_initiatives`). Their issues are not synced or ingested; follow the link for detail.', '',
    body, '',
    '## Sources', '- [[linear/catalog]]', '',
  ].join('\n');
  const abs = path.join(vault, rel);
  const old = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  if (old.replace(/^updated:.*$/m, '') === page.replace(/^updated:.*$/m, '')) return null;
  fs.writeFileSync(abs, page);
  const idx = path.join(vault, 'wiki', 'index.md');
  const index = fs.readFileSync(idx, 'utf8');
  if (!index.includes('[[wiki/initiatives/linear-catalog]]')) addToIndex(vault, ['wiki/initiatives/linear-catalog.md']);
  return rel;
}

// --- splitting ---------------------------------------------------------------

function packLines(text, max) {
  const out = []; let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = ''; }
    cur += `${line}\n`;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// A file becomes one or more entries. Slack: every top-level message (with its
// thread) is its own entry, labelled with the section it sits in. Anything
// else: the whole file, or heading-sized pieces when it is big.
function entriesOf(rel, text) {
  const { fm, body } = splitFrontmatter(text);
  const head = fm ? `---\n${fm}\n---\n` : '';
  const pieces = [];
  if (rel.startsWith('slack/')) {
    let section = '', cur = null;
    for (const line of body.split('\n')) {
      if (/^## /.test(line)) { if (cur) pieces.push(cur); cur = null; section = line.slice(3).trim(); continue; }
      if (/^- \*\*/.test(line)) { if (cur) pieces.push(cur); cur = { label: section, text: `${line}\n` }; continue; }
      if (cur) cur.text += `${line}\n`;
    }
    if (cur) pieces.push(cur);
  } else if (text.length <= PART_BYTES) {
    pieces.push({ label: '', text: body });
  } else {
    let cur = { label: '', text: '' };
    for (const line of body.split('\n')) {
      if (/^#{1,3} /.test(line) && cur.text.length > PART_BYTES / 3) { pieces.push(cur); cur = { label: line.replace(/^#+\s*/, ''), text: '' }; }
      cur.text += `${line}\n`;
    }
    if (cur.text.trim()) pieces.push(cur);
  }
  const out = [];
  for (const p of pieces) {
    const parts = p.text.length > PART_BYTES ? packLines(p.text, PART_BYTES) : [p.text];
    parts.forEach((t, k) => out.push({ rel, label: p.label + (parts.length > 1 ? ` (piece ${k + 1}/${parts.length})` : ''), text: t }));
  }
  // The frontmatter carries the dates and titles; give it to the first entry.
  if (out.length && head) out[0].text = head + out[0].text;
  return out;
}

// Stable identity of an entry across runs and groupings: its file + text.
const entryKey = (e) => crypto.createHash('sha1').update(`${e.rel}\0${e.text}`).digest('hex');

// --- blocks ------------------------------------------------------------------

const BLOCK_RE = /<<<(FILE|APPEND) ([^\n]+)\n([\s\S]*?)\n?<<<END>>>|<<<EDIT ([^\n]+)\n<<<OLD\n([\s\S]*?)\n<<<NEW\n([\s\S]*?)\n?<<<END>>>/g;
// Where an APPEND goes: before the page's closing run of "## Open questions" /
// "## Related" / "## Sources" headings. Not before the FIRST such heading: on
// the two largest pages that was often an early stray "## Open questions (added …)",
// so new sections landed mid-page and the pages grew into 300KB logs.
function tailStart(text) {
  const heads = [...text.matchAll(/^## (.*)$/gm)];
  let at = -1;
  for (let i = heads.length - 1; i >= 0; i--) {
    if (/^(Open questions|Related|Sources)\b/.test(heads[i][1])) at = heads[i].index; else break;
  }
  return at;
}

function parseBlocks(text) {
  const ops = [];
  for (const m of String(text).matchAll(BLOCK_RE)) {
    if (m[1]) ops.push({ kind: m[1].toLowerCase(), rel: m[2].trim().replace(/^\.\//, ''), text: m[3] });
    else ops.push({ kind: 'edit', rel: m[4].trim().replace(/^\.\//, ''), old: m[5], neu: m[6] });
  }
  return ops;
}

// Apply blocks to in-memory copies of the current pages. Returns the changed
// pages, which pages each op touched, and what could not be applied.
function applyBlocks(vault, ops, pages = new Map()) {
  const root = path.join(vault, 'wiki') + path.sep;
  const misses = [], applied = new Set(), seen = new Set();
  const isNew = (rel) => !fs.existsSync(path.join(vault, rel));
  const current = (rel) => (pages.has(rel) ? pages.get(rel) : (() => { try { return fs.readFileSync(path.join(vault, rel), 'utf8'); } catch { return null; } })());
  for (const op of ops) {
    const { rel } = op;
    if (!rel.endsWith('.md') || !path.resolve(vault, rel).startsWith(root) || rel === 'wiki/log.md') { misses.push(`${op.kind.toUpperCase()} outside the allowed wiki area: ${rel}`); continue; }
    const key = JSON.stringify(op);
    if (seen.has(key)) continue; // the final result repeats the last message
    seen.add(key);
    const cur = current(rel);
    if (op.kind === 'file') {
      if (!isNew(rel)) { misses.push(`FILE refused for ${rel}: the page exists; use APPEND or EDIT, never a full rewrite`); continue; }
      pages.set(rel, op.text.endsWith('\n') ? op.text : `${op.text}\n`); applied.add(rel); continue;
    }
    if (cur === null) { misses.push(`${op.kind.toUpperCase()} on a page that doesn't exist: ${rel} (use FILE to create it)`); continue; }
    if (op.kind === 'append') {
      const add = `${op.text.trim()}\n\n`;
      const t = tailStart(cur);
      pages.set(rel, t >= 0 ? cur.slice(0, t) + add + cur.slice(t) : `${cur.replace(/\n*$/, '\n\n')}${add}`);
      applied.add(rel); continue;
    }
    let old = op.old;
    let n = cur.split(old).length - 1;
    if (n === 0) { // tolerate Grep's "123:" line prefixes
      const stripped = old.split('\n').map((l) => l.replace(/^\d+[:-]/, '')).join('\n');
      if (stripped !== old) { old = stripped; n = cur.split(old).length - 1; }
    }
    if (n !== 1) { misses.push(`EDIT not applied in ${rel}: OLD text found ${n} times, need exactly 1. OLD began: ${JSON.stringify(op.old.slice(0, 120))}`); continue; }
    pages.set(rel, cur.replace(old, () => op.neu));
    applied.add(rel);
  }
  return { pages, applied, misses };
}

function parseManifest(text) {
  const m = String(text || '').match(/MANIFEST:\s*(\{[\s\S]*\})\s*$/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// --- one part ------------------------------------------------------------------

function partPrompt(vault, part, k, n, ownerName, startIso) {
  const body = part.entries.map((e) => `=== [${e.id}] ${e.rel}${e.label ? ` · ${e.label}` : ''}${e.primary || e.related.length ? ` · likely: ${[e.primary, ...e.related].filter(Boolean).join(', ')}` : ''} ===${e.hint ? `\nOWNER ASKED FOR THIS FILE TO BE RE-INGESTED. The verifier found this missing from the wiki: ${e.hint}` : ''}\n${e.text.trimEnd()}`).join('\n\n');
  return [
    `You are the vault's ingest bot, running unattended. This is part ${k} of ${n} of one ingest run; your working directory is the vault root. The owner is ${ownerName}.`,
    '',
    part.primaries.length
      ? `This part is grouped around: ${part.primaries.join(', ')}. Entries about it from every day in the delta are here together, in time order, so a later entry supersedes an earlier one. Grep that page for the headings and claims you need and Read only those sections (large pages are slow to read whole), then fold all of its entries in one pass. The "likely:" hint on each entry is a mechanical guess from names and channels; follow the content, not the hint.`
      : 'These entries have no wiki page yet (or no clear one). They are clustered by channel or project. Decide per entry whether it belongs on an existing page, warrants a new page per the thresholds, or adds nothing. The "likely:" hint is a mechanical guess.',
    '',
    'The raw content for this part is below, complete. Do not Read raw files; Read and Grep the wiki instead.',
    `For EVERY entry [E#], fold what it adds into the wiki, or say why it adds nothing. An entry that carries a decision, a date, a status change, an ask of ${ownerName}, a new person, a number, a ticket, or a correction of something the wiki says is NOT "nothing". Bot notifications, emoji-only replies and pure scheduling chatter usually are.`,
    'Wiki prose: Write about 80% to ASD-STE100 Simplified Technical English: short sentences (about 20 words for prose, 15 for steps), common words with one meaning each, the same term for the same thing every time, active voice, one instruction per sentence, one idea per paragraph, no hedging words, keep articles. Keep a natural tone.',
    'Before writing, Grep wiki/ for the entities in the entry (partner, customer, person, ticket IDs, project names) to find the right pages and see what they already say. Some of this content may already be in the wiki from an earlier pass: do not add it twice.',
    '',
    'You cannot write files. Put blocks in your reply:',
    '  Add to an existing page (the runner inserts it before the page\'s "## Open questions" / "## Related" / "## Sources"):',
    '    <<<APPEND wiki/partners/example.md',
    `    ### ${startIso.slice(0, 10)}: <headline>`,
    '    <content, citing raw like [[slack/2026-09-22]] or [[gdrive/files/<id>]]>',
    '    <<<END>>>',
    '  Change existing text (copy OLD from Grep output, WITHOUT the "123:" line-number prefix; one or a few whole lines; must be unique in the file):',
    '    <<<EDIT wiki/partners/example.md',
    '    <<<OLD',
    '    <exact current line(s)>',
    '    <<<NEW',
    '    <replacement>',
    '    <<<END>>>',
    '  Create a page that does not exist yet (promotion thresholds below), and EDIT wiki/index.md to list it:',
    '    <<<FILE wiki/people/example-person.md',
    '    <full page: frontmatter per the conventions, body per the template>',
    '    <<<END>>>',
    '  Never re-emit an existing page (refused). Never edit sources: or updated: on existing pages; the runner sets them from your MANIFEST.',
    '',
    'Keep the wiki TRUE, not just longer:',
    '  - When an entry changes a fact (a date moved, a status changed, an option was decided), EDIT the old claim where it stands: replace it, or mark it "(superseded YYYY-MM-DD: <new fact>)". Two conflicting dates must not both stand unmarked.',
    '  - A page with a history companion (wiki/<dir>/<slug>-history.md exists) is a HUB: EDIT its "## Current state", "## Timeline" and "## Open questions" sections in place, and APPEND dated narrative ("### YYYY-MM-DD: <headline>") to the -history page, never to the hub.',
    '  - When an entry answers an open question, EDIT its "- [ ]" to "- [x]" with the answer in a few words.',
    '  - A contradiction is two claims (wiki vs wiki, or wiki vs this raw) that disagree and that you could NOT resolve from the content. Only those go in "contradictions".',
    `  - People: create or update wiki/people/ pages per the thresholds (an external partner DRI with one substantive thread; an internal person who engaged ${ownerName} directly). Calendar attendees with responseStatus accepted are who was in the room.`,
    '  - Recurring calendar instances with nothing new fold into one mention.',
    '',
    'Finish your reply with exactly one line, nothing after it:',
    'MANIFEST: {"entries":{"E1":{"pages":["wiki/<path>.md"]},"E2":{"skip":"<why it adds nothing>"}},"contradictions":["<claim A vs claim B>"],"source_balance":["wiki/<path>.md: <why it cites one class or no human-authored class>"],"summary":"<one line>"}',
    `Every entry ID (E1..E${part.entries.length}) must appear. "pages" lists every page you changed for that entry, and each must have a block in your reply.`,
    '',
    '================ THE OPERATION (from the vault CLAUDE.md; steps 0-2, 4 and 5 are the runner\'s) ================',
    specSection(vault, 'Ingest'),
    '',
    '================ WIKI CONVENTIONS ================',
    wikiConventions(vault),
    '',
    '================ VAULT RULES ================',
    rulesSection(vault),
    '',
    `================ RAW CONTENT, PART ${k} OF ${n} (${part.entries.length} entries) ================`,
    body,
  ].join('\n');
}

function checkPart(vault, part, mf, pages, applied, misses) {
  const problems = [];
  if (!mf) return { problems: ['no MANIFEST line'], claims: new Map() };
  const entries = mf.entries || {};
  const claims = new Map(); // page -> Set(raw rel)
  for (const e of part.entries) {
    const v = entries[e.id];
    if (!v || (!(v.pages || []).length && !v.skip)) { problems.push(`${e.id} (${e.rel}) is neither folded in nor skipped`); continue; }
    for (const p of v.pages || []) {
      const rel = String(p).replace(/^\.\//, '').replace(/^\[\[|\]\]$/g, '').replace(/(\.md)?$/, '.md');
      if (!applied.has(rel)) { problems.push(`${e.id} claims ${rel} but no block for it applied`); continue; }
      if (!claims.has(rel)) claims.set(rel, new Set());
      claims.get(rel).add(e.rel);
    }
  }
  // New pages must be reachable from the index.
  const index = pages.get('wiki/index.md') || fs.readFileSync(path.join(vault, 'wiki', 'index.md'), 'utf8');
  for (const rel of pages.keys()) {
    if (fs.existsSync(path.join(vault, rel)) || rel === 'wiki/index.md') continue;
    if (!index.includes(`[[${rel.replace(/\.md$/, '')}`)) problems.push(`new page ${rel} is not listed in wiki/index.md`);
  }
  return { problems: [...misses, ...problems], claims };
}

async function runPart(ctx, part, k, n) {
  const { run, claudeBin, vault, env, logLine, ownerName, startIso, mutex, date } = ctx;
  const tools = ['Read(./wiki/**)', 'Glob', 'Grep'];
  const args = (prompt, resume) => [
    '-p', prompt, '--model', 'sonnet',
    ...(resume ? ['--resume', resume] : []),
    '--output-format', 'stream-json', '--verbose',
    '--allowedTools', tools.join(','),
    '--tools', 'Read,Glob,Grep',
    '--disallowedTools', 'Agent,Task,Write,Edit,NotebookEdit,Bash',
    // No --permission-mode override: the owner's auto mode stays in force.
    '--permission-prompts', 'none',
    '--setting-sources', 'user',
    '--max-budget-usd', String(PART_BUDGET),
    // No MCP servers. Ingest only reads the wiki, and the connected servers'
    // tool definitions (~600k tokens, measured 2026-10-02) otherwise ride in
    // the context of every turn: $1.04 per part with them, $0.22 without.
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ];
  let calls = 0;
  const call = async (prompt, resume) => {
    const texts = [];
    const r = await claudeStream(claudeBin, args(prompt, resume), {
      cwd: vault, env, timeoutMs: 30 * 60000,
      onEvent: (ev) => {
        if (ev.type !== 'assistant') return;
        for (const p of (ev.message && ev.message.content) || []) {
          if (p.type === 'text' && p.text) texts.push(p.text);
          if (p.type === 'tool_use') calls++;
        }
      },
    });
    return { r, texts };
  };

  const label = `part ${k}/${n} (${part.entries.length} entries: ${[...new Set(part.entries.map((e) => e.rel))].join(', ').slice(0, 140)})`;
  logLine(run, `▶ ${label}`);
  let { r, texts } = await call(partPrompt(vault, part, k, n, ownerName, startIso));
  let cost = (r.result && r.result.total_cost_usd) || 0;
  if (!r.result) return { ok: false, cost, why: `claude exited ${r.code} with no result` };
  if (r.result.subtype === 'error_max_budget_usd') return { ok: false, cost, why: `hit the $${PART_BUDGET} part budget` };
  let ops = parseBlocks([...texts, r.result.result || ''].join('\n'));
  let mf = parseManifest(r.result.result);

  return mutex(async () => {
    let { pages, applied, misses } = applyBlocks(vault, ops);
    let check = checkPart(vault, part, mf, pages, applied, misses);
    if (check.problems.length && r.result.session_id) {
      logLine(run, `  ${check.problems.length} problem(s); one retry in the same session`);
      const fix = [
        'The runner could not accept your reply yet. Problems:',
        ...check.problems.map((p) => `- ${p}`),
        '',
        'The pages may have changed since you read them (other parts run alongside you). Grep or Read them again, then reply with ONLY the corrected or missing blocks (blocks that already applied stay applied; do not repeat them) and a complete MANIFEST line covering every entry.',
      ].join('\n');
      ({ r, texts } = await call(fix, r.result.session_id));
      cost += (r.result && r.result.total_cost_usd) || 0;
      if (r.result && r.result.subtype !== 'error_max_budget_usd') {
        const ops2 = parseBlocks([...texts, r.result.result || ''].join('\n'));
        const mf2 = parseManifest(r.result.result);
        const second = applyBlocks(vault, ops2, pages);
        for (const a of second.applied) applied.add(a);
        if (mf2) mf = { ...mf2, entries: { ...((mf && mf.entries) || {}), ...(mf2.entries || {}) } };
        check = checkPart(vault, part, mf, second.pages, applied, second.misses);
        pages = second.pages;
      }
    }
    if (check.problems.length) {
      for (const p of check.problems.slice(0, 6)) logLine(run, `  GATE: ${p}`);
      return { ok: false, cost, why: `${check.problems.length} problem(s) after retry`, problems: check.problems };
    }
    // Pass: write, then stamp provenance mechanically from the manifest.
    for (const [rel, text] of pages) {
      const stamped = check.claims.has(rel) ? stampFrontmatter(text, [...check.claims.get(rel)], date) : text;
      fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
      fs.writeFileSync(path.join(vault, rel), stamped);
    }
    const skips = part.entries.filter((e) => mf.entries[e.id] && mf.entries[e.id].skip).length;
    logLine(run, `  ✓ part ${k}: ${pages.size} page(s) written, ${part.entries.length - skips} entries folded, ${skips} judged empty · ${calls} tool calls · $${cost.toFixed(2)}`);
    return { ok: true, cost, pages: [...pages.keys()], mf, part };
  });
}

// --- the run -------------------------------------------------------------------

async function runIngest(run, { claudeBin, vault, env, logLine, finish, latestFor, syncBotIds }, opts = {}) {
  const startMs = Date.now();
  const startIso = new Date(startMs).toISOString().replace(/\.\d+Z$/, 'Z');
  const date = dayOf(startMs, getConfig(vault).owner.timezone);
  const ownerName = readOwner(vault).name || 'the owner';

  // Held sources: their latest sync failed, so their files wait (ledger).
  const held = syncBotIds
    .map((id) => ({ id, dir: id.replace('sync-', ''), last: latestFor(id) }))
    .filter((x) => x.last && x.last.status === 'error');
  const dw = await deltaWalk(vault);
  if (dw.code !== 0 || !dw.deltasLine) return finish(run, 'error', `delta-walk failed (exit ${dw.code})`, { raw: dw.raw.slice(-1500) });
  logLine(run, dw.deltasLine);
  const heldDirs = held.map((h) => `${h.dir}/`);
  const isHeld = (f) => heldDirs.some((x) => f.startsWith(x));
  const heldFiles = dw.files.filter(isHeld);
  const ledgerPath = path.join(vault, '.bot', 'state', 'ingest-held.json');
  let ledger = []; try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch {}
  const released = ledger.filter((f) => !isHeld(f) && fs.existsSync(path.join(vault, f)));
  const explicit = (opts.files || []).filter((f) => fs.existsSync(path.join(vault, f)));
  let files = [...new Set([...dw.files, ...released, ...explicit])].filter((f) => !isHeld(f));
  const stillHeld = [...new Set([...ledger.filter(isHeld), ...heldFiles])];
  if (released.length) logLine(run, `released ${released.length} previously held file(s)`);
  if (explicit.length) logLine(run, `re-ingesting ${explicit.length} named file(s)`);
  for (const h of held) logLine(run, `HELD ${h.dir}/: its latest sync failed; ${heldFiles.filter((f) => f.startsWith(`${h.dir}/`)).length} file(s) left for the next ingest`);

  // Mechanical skips. Named files skip the hash rule: they were named on purpose.
  const hashesPath = path.join(vault, '.bot', 'state', 'ingested-hashes.json');
  let ingested = {}; try { ingested = JSON.parse(fs.readFileSync(hashesPath, 'utf8')); } catch {}
  const excludes = new Set(getConfig(vault).ingest.exclude.map(String));
  let tiers;
  try { tiers = linearTiers(vault); } catch (e) { return finish(run, 'error', e.message); }
  const skipped = [];
  files = files.filter((f) => {
    let why = excludes.has(f) ? 'excluded by config.yaml (ingest.exclude)' : runnerSkip(vault, f, explicit.includes(f) ? null : ingested);
    if (!why && f.startsWith('linear/') && linearLinkOnly(f, fs.readFileSync(path.join(vault, f), 'utf8'), tiers, ownerName)) why = 'link-only Linear tier (config.yaml linear.deep_initiatives); listed in wiki/initiatives/linear-catalog.md';
    if (why) skipped.push({ path: f, why });
    return !why;
  });
  const linkOnly = skipped.filter((x) => x.why.startsWith('link-only'));
  for (const s of skipped) if (!s.why.startsWith('link-only')) logLine(run, `skip ${s.path}: ${s.why}`);
  if (linkOnly.length) logLine(run, `skip ${linkOnly.length} link-only Linear file(s) (not in a deep initiative, no mention of ${ownerName})`);
  if (!files.length) {
    if (!skipped.length) return finish(run, 'ok', 'nothing new since the last ingest', { deltasLine: dw.deltasLine });
  }

  // Human-authored and fast-moving sources first, so a run stopped at the cap
  // has already folded in what matters most. Order within a class is by path.
  const ORDER = ['slack/', 'gdrive/', 'gcal/', 'projects/', 'notion/', 'linear/'];
  const rank = (f) => { const i = ORDER.findIndex((x) => f.startsWith(x)); return i < 0 ? ORDER.length : i; };
  files.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  let diffed = 0;
  const entries = files.flatMap((f) => {
    const text = fs.readFileSync(path.join(vault, f), 'utf8');
    if (!diffEligible(f, text) || !fs.existsSync(snapPath(vault, f))) return entriesOf(f, text);
    const changes = changedOnly(fs.readFileSync(snapPath(vault, f), 'utf8'), text);
    if (!changes) { skipped.push({ path: f, why: 'body unchanged since it was last ingested' }); return []; }
    diffed++;
    return entriesOf(f, `---\n${splitFrontmatter(text).fm}\n---\n_Only the changes since this page was last ingested are shown; unchanged content is omitted._\n\n${changes}\n`);
  });
  if (diffed) logLine(run, `${diffed} mentioned-only Notion page(s): sending only the changes since their last ingest`);
  // Progress is per entry (by content hash), so a resumed run skips exactly
  // the entries already folded in, however the remaining ones get grouped.
  const progressPath = path.join(vault, '.bot', 'state', 'ingest-progress.json');
  let progress = { entries: {}, notes: [] };
  try { const p = JSON.parse(fs.readFileSync(progressPath, 'utf8')); if (p.entries && p.notes) progress = p; } catch {}
  const pending = entries.filter((e) => !progress.entries[entryKey(e)]);
  // A named re-ingest can carry why it was named (Verify found its facts missing),
  // so the model does not wave the entry through as "adds nothing" again.
  const hints = opts.hints || {};
  const parts = groupParts(route(vault, pending).map((e) => (hints[e.rel] ? { ...e, hint: String(hints[e.rel]) } : e)), PART_BYTES, rank);
  logLine(run, `${files.length} file(s) → ${entries.length} entries${entries.length - pending.length ? ` (${entries.length - pending.length} already done by an earlier run)` : ''} → ${parts.length} part(s) grouped by wiki page · sonnet ×${CONCURRENCY} · $${PART_BUDGET}/part, $${RUN_BUDGET} cap`);
  const saveProgress = () => { fs.mkdirSync(path.dirname(progressPath), { recursive: true }); fs.writeFileSync(progressPath, JSON.stringify(progress, null, 1)); };

  let chain = Promise.resolve();
  const mutex = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  const ctx = { run, claudeBin, vault, env, logLine, ownerName, startIso, mutex, date };
  let cost = 0, stopped = false, started = 0;
  const results = [];
  const queue = parts.map((p, i) => ({ p, k: i + 1 }));
  // Two parts about the same page never run at once: the second would edit
  // text the first is about to change.
  const inflight = new Set();
  const nextPart = () => {
    const i = queue.findIndex(({ p }) => !p.primaries.some((x) => inflight.has(x)));
    return i < 0 ? null : queue.splice(i, 1)[0];
  };
  const worker = async () => {
    while (queue.length) {
      if (cost >= RUN_BUDGET || (opts.maxParts && started >= opts.maxParts)) { stopped = true; return; }
      const job = nextPart();
      if (!job) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      const { p, k } = job;
      started++;
      p.primaries.forEach((x) => inflight.add(x));
      let res;
      try { res = await runPart(ctx, p, k, parts.length); } catch (e) { res = { ok: false, cost: 0, why: e.message }; }
      p.primaries.forEach((x) => inflight.delete(x));
      cost += res.cost || 0;
      results.push({ k, ...res });
      if (res.ok) {
        for (const e of p.entries) {
          const v = res.mf.entries[e.id] || {};
          progress.entries[entryKey(e)] = v.skip ? { rel: e.rel, skip: v.skip } : { rel: e.rel, pages: v.pages || [] };
        }
        progress.notes.push({ pages: res.pages, contradictions: res.mf.contradictions || [], source_balance: res.mf.source_balance || [], summary: res.mf.summary || '' });
        saveProgress();
      } else logLine(run, `  ✗ part ${k}: ${res.why}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parts.length) }, worker));

  const failed = results.filter((x) => !x.ok);
  const left = queue.length;
  if (failed.length || stopped || left) {
    return finish(run, 'error', `${parts.length - failed.length - left}/${parts.length} parts done${failed.length ? `, ${failed.length} failed` : ''}${left ? `, ${left} not started (${opts.maxParts ? `test limit ${opts.maxParts} parts` : `run cap $${RUN_BUDGET}`})` : ''}; finished parts are kept, Run again resumes; log + watermark NOT written`,
      { failed: failed.map((f) => ({ part: f.k, why: f.why, problems: (f.problems || []).slice(0, 10) })) }, cost);
  }

  const catalogPage = renderCatalogPage(vault, date);
  if (catalogPage) logLine(run, `rendered ${catalogPage} from linear/catalog.md`);
  // Every entry is accounted for (this run or an earlier one): log entry, then watermark.
  const pagesAll = [...new Set([...progress.notes.flatMap((x) => x.pages), ...(catalogPage ? [catalogPage] : [])])].sort();
  const contradictions = [...new Set(progress.notes.flatMap((m) => m.contradictions))];
  const balance = [...new Set(progress.notes.flatMap((m) => m.source_balance))];
  const entrySkips = entries.filter((e) => (progress.entries[entryKey(e)] || {}).skip).length;
  const mfs = progress.notes;
  const summary = mfs.map((m) => m.summary).filter(Boolean).slice(0, 3).join('; ').slice(0, 220) || 'unattended ingest';
  const header = `## [${startIso.slice(0, 10)} ${startIso.slice(11, 16)}] ingest | ${summary.replace(/\n/g, ' ')}`;
  const entry = [
    '', header,
    dw.deltasLine,
    ...(held.length ? [`Held (sync failing, not ingested this pass): ${held.map((h) => `${h.dir}/=${heldFiles.filter((f) => f.startsWith(`${h.dir}/`)).length}`).join(', ')}`] : []),
    ...(explicit.length ? [`Re-ingested by name: ${explicit.length} file(s)`] : []),
    'Sources touched:', ...files.map((s) => `- ${s}`),
    'Wiki pages updated:', ...pagesAll.map((s) => `- ${s}`),
    ...(skipped.length ? ['Skipped by the runner:', ...skipped.filter((x) => !x.why.startsWith('link-only')).map((x) => `- ${x.path}: ${x.why}`),
      ...(linkOnly.length ? [`- ${linkOnly.length} link-only Linear file(s): config.yaml linear.deep_initiatives`] : [])] : []),
    ...balance.map((b) => `[source-balance] ${b}`),
    ...(contradictions.length ? ['Contradictions flagged:', ...contradictions.map((c) => `- ${c}`)] : []),
    `Run: Brain ingest bot · ${progress.notes.length} parts, ${entries.length} entries (${entrySkips} judged empty) · $${cost.toFixed(2)} this run`,
    '',
  ].join('\n');
  fs.appendFileSync(path.join(vault, 'wiki', 'log.md'), entry);
  fs.writeFileSync(path.join(vault, 'wiki', '.last-ingest'), `${startIso}\n`);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(stillHeld.sort(), null, 2));
  // Keep the per-entry decisions (folded into which pages, or why skipped) for
  // the Verify bot's spot-check; the run-scoped progress file can go.
  const decisionsPath = path.join(vault, '.bot', 'state', 'ingest-decisions.json');
  let decisions = {}; try { decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8')); } catch {}
  for (const [k, v] of Object.entries(progress.entries)) decisions[k] = { ...v, at: startIso };
  const keep = Object.entries(decisions).sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).slice(0, 8000);
  fs.writeFileSync(decisionsPath, JSON.stringify(Object.fromEntries(keep)));
  fs.rmSync(progressPath, { force: true });
  // Remember exactly what was ingested: the hash (identical re-render is
  // skipped next time) and, for Notion/Linear/Drive, a copy to diff against.
  fs.mkdirSync(path.join(vault, '.bot', 'state', 'ingested'), { recursive: true });
  for (const f of files) {
    try {
      const t = fs.readFileSync(path.join(vault, f), 'utf8');
      ingested[f] = sha(t);
      if (SNAP_CLASSES.some((c) => f.startsWith(c))) fs.writeFileSync(snapPath(vault, f), t);
    } catch {}
  }
  fs.writeFileSync(hashesPath, JSON.stringify(ingested, null, 1));
  logLine(run, `log.md entry appended; .last-ingest → ${startIso}`);
  const c = contradictions.length;
  finish(run, c ? 'warn' : 'ok', `${files.length} files → ${pagesAll.length} wiki pages · ${entries.length} entries, ${entrySkips} judged empty${c ? ` · ${c} contradiction(s) need you` : ''}`,
    { deltasLine: dw.deltasLine, pages: pagesAll, contradictions, balance, skipped }, cost);
}

module.exports = { deltaWalk, splitFrontmatter, fmField, runIngest, applyBlocks, parseBlocks, stampFrontmatter, entriesOf, entryKey, runnerSkip, linearLinkOnly, changedOnly, diffEligible };
