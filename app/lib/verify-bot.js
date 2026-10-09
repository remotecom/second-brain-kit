// Verify bot: checks the wiki against what the ingest bot says it did, and
// keeps the queue of things only the owner can settle.
//
//   deterministic ($0)                          model (~$0.5, sonnet, reads the wiki only)
//   ──────────────────                          ──────────────────────────────────────────
//   raw changed since it was ingested           spot-check: sample ~10 raw entries (prefer ones
//   frontmatter / tag-namespace violations        the ingest judged "adds nothing"), grep the wiki,
//   pages missing from wiki/index.md              verdict covered | partial | missing | trivial
//   stale pages (cited source newer than page)
//   lint (dead links, raw purity, annotations)
//   contradictions from log.md ─▶ Needs-You.md  (preserves the owner's ticks)
//
// Nothing here edits the wiki or raw. Output: Needs-You.md at the vault root
// (contradictions + possible coverage gaps) and the run record.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { claudeStream } = require('./sync');
const { addToIndex } = require('./wiki-index');
const { entriesOf, entryKey, splitFrontmatter, fmField } = require('./ingest');

const SPOT_N = 10;
const SPOT_BUDGET = 2;
const TAG_NS = /^(partner|domain|problem|tech|customer|system|integrator)\//;
const WIKI_TYPES = new Set(['partner', 'system', 'integrator', 'problem', 'person', 'incident', 'initiative', 'principle', 'concept', 'workflow', 'customer']);
const SUBSTANCE = /\b[A-Z]{2,6}-\d{2,5}\b|\b(decid|agreed|launch|go-live|deadline|blocked|approv|signed|priority|rollout|contract|renewal|pricing)\w*|\$\s?\d|\b\d{1,2}\/\d{1,2}\b/i;

const sha7 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 7);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

function walk(dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out); else if (d.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function bash(script, cwd) {
  return new Promise((resolve) => {
    const c = spawn('/bin/bash', [script], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
}

// --- deterministic checks -----------------------------------------------------

function wikiChecks(vault) {
  const pages = walk(path.join(vault, 'wiki')).map((abs) => ({ abs, rel: path.relative(vault, abs) }))
    .filter((p) => !['wiki/index.md', 'wiki/log.md'].includes(p.rel));
  const index = fs.readFileSync(path.join(vault, 'wiki', 'index.md'), 'utf8');
  const bad = [], unindexed = [], stale = [];
  for (const p of pages) {
    const text = fs.readFileSync(p.abs, 'utf8');
    const { fm } = splitFrontmatter(text);
    const why = [];
    if (fm === null) why.push('no frontmatter');
    else {
      if (fmField(fm, 'type') !== 'wiki') why.push('type is not wiki');
      const wt = fmField(fm, 'wiki_type');
      if (!wt || !WIKI_TYPES.has(wt)) why.push(`wiki_type "${wt || ''}"`);
      // Tags only: the block under "tags:" (a YAML list or an inline array), not sources:.
      const tagBlock = (fm.match(/^tags:\s*\[(.*)\]\s*$/m) || [])[1] || (fm.match(/^tags:\s*\n((?:\s+-\s.*\n?)*)/m) || [, ''])[1];
      for (const m of tagBlock.matchAll(/([a-z][\w-]*\/[\w./-]+)/g)) if (!TAG_NS.test(m[1])) why.push(`tag ${m[1]}`);
    }
    if (why.length) bad.push(`${p.rel}: ${why.join(', ')}`);
    if (!index.includes(`[[${p.rel.replace(/\.md$/, '')}`)) unindexed.push(p.rel);
    // Stale: a cited source's own content date is later than the page's updated:.
    const updated = fm && fmField(fm, 'updated');
    if (updated) {
      let newest = '';
      for (const m of (fm.match(/^sources:\s*\n((?:\s+-\s.*\n?)*)/m) || [, ''])[1].matchAll(/^\s+-\s*(.+?)\s*$/gm)) {
        const src = m[1].replace(/^["']|["']$/g, '').replace(/^\[\[|\]\]$/g, '');
        const rel = /\.md$/.test(src) ? src : `${src}.md`;
        let d = (rel.match(/^(?:slack|gcal)\/(\d{4}-\d{2}-\d{2})\.md$/) || [])[1];
        if (!d) {
          let t; try { t = fs.readFileSync(path.join(vault, rel), 'utf8'); } catch { continue; }
          const f = splitFrontmatter(t).fm;
          d = ['updated_at', 'last_edited_time', 'modified_time'].map((k) => fmField(f, k)).find((x) => /^\d{4}-\d{2}-\d{2}/.test(x || ''));
          d = d && d.slice(0, 10);
        }
        if (d && d > newest) newest = d;
      }
      if (newest && newest > updated) stale.push({ rel: p.rel, updated, newest });
    }
  }
  stale.sort((a, b) => (a.newest < b.newest ? 1 : -1));
  return { bad, unindexed, stale, pages: pages.length };
}

function changedSinceIngest(vault) {
  const hashes = readJson(path.join(vault, '.bot', 'state', 'ingested-hashes.json'), {});
  const changed = [];
  for (const [rel, h] of Object.entries(hashes)) {
    let t; try { t = fs.readFileSync(path.join(vault, rel), 'utf8'); } catch { continue; }
    if (crypto.createHash('sha256').update(t).digest('hex') !== h) changed.push(rel);
  }
  return { tracked: Object.keys(hashes).length, changed };
}

// --- contradictions queue -----------------------------------------------------

function newContradictions(vault) {
  const log = fs.readFileSync(path.join(vault, 'wiki', 'log.md'), 'utf8');
  const statePath = path.join(vault, '.bot', 'state', 'verify-seen.json');
  const state = readJson(statePath, null);
  // First run: only the latest ingest entry (older ones were reviewed by hand).
  const entries = [...log.matchAll(/^## \[(\d{4}-\d{2}-\d{2}) [\d:]+\] ingest[^\n]*\n([\s\S]*?)(?=^## \[|\s*$(?![\s\S]))/gm)];
  const take = state ? entries.filter((m) => m.index >= state.offset) : entries.slice(-1);
  const items = [];
  for (const m of take) {
    const block = (m[2].match(/^Contradictions flagged:\n((?:- .*\n?)+)/m) || [, ''])[1];
    for (const l of block.split('\n').filter((x) => x.startsWith('- '))) items.push({ date: m[1], text: l.slice(2).trim() });
  }
  return { items, offset: log.length, statePath };
}

function parseNeedsYou(text) {
  const items = new Map();
  let section = '', cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^## (.+)/); if (h) { section = h[1]; cur = null; continue; }
    const i = line.match(/^### (c-[0-9a-f]{7}|g-[0-9a-f]{7}) · (\S+)/);
    if (i) { cur = { id: i[1], date: i[2], text: '', boxes: [], section }; items.set(cur.id, cur); continue; }
    if (!cur) continue;
    const b = line.match(/^- \[( |x)\] (.+)/i);
    if (b) cur.boxes.push({ on: b[1].toLowerCase() === 'x', label: b[2] }); else if (line.trim() && !cur.boxes.length) cur.text += (cur.text ? '\n' : '') + line;
  }
  return items;
}

const CONTRA_BOXES = ['the first claim is right', 'the second claim is right', 'both are out of date, ignore'];
const GAP_BOXES = ['it is already covered, ignore', 're-ingest this file'];

// Which items the Resolve bot has applied, by id (.bot/state/needs-applied.json).
// A ticked item stays in its open section until its answer has actually landed.
function appliedIds(vault) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(path.join(vault, '.bot', 'state', 'needs-applied.json'), 'utf8')); } catch {}
  return new Set(Object.entries(s).filter(([, v]) => v && v.ok).map(([k]) => k));
}

function renderNeedsYou(items, applied = new Set()) {
  const group = (pred) => [...items.values()].filter(pred);
  const block = (it) => [`### ${it.id} · ${it.date}`, it.text, ...it.boxes.map((b) => `- [${b.on ? 'x' : ' '}] ${b.label}`), ''];
  const open = (it) => !applied.has(it.id);
  const out = [
    '# Needs you', '',
    'Things the bots could not settle themselves. Tick one box per item. The Resolve bot (or the Morning run) applies your answer to the wiki, notes what it changed under the item, and moves it to Resolved.',
    'Written by the Verify bot (Second Brain app). Contradictions come from ingest; gaps come from the Verify spot-check.', '',
    '## Contradictions', '',
    ...group((i) => i.id.startsWith('c-') && open(i)).flatMap(block),
    '## Possibly missing from the wiki', '',
    ...group((i) => i.id.startsWith('g-') && open(i)).flatMap(block),
    '## Resolved', '',
    ...group((i) => !open(i)).flatMap(block),
  ];
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

// --- spot-check ---------------------------------------------------------------

function pickSamples(vault) {
  const hashes = readJson(path.join(vault, '.bot', 'state', 'ingested-hashes.json'), {});
  const decisions = readJson(path.join(vault, '.bot', 'state', 'ingest-decisions.json'), {});
  const pool = [];
  for (const rel of Object.keys(hashes)) {
    if (!/^(slack|gdrive|notion|projects)\//.test(rel)) continue;
    let t; try { t = fs.readFileSync(path.join(vault, rel), 'utf8'); } catch { continue; }
    for (const e of entriesOf(rel, t)) {
      const body = splitFrontmatter(e.text).body;
      if (body.length < 300 || body.length > 6000 || !SUBSTANCE.test(body)) continue;
      const d = decisions[entryKey(e)];
      pool.push({ rel, label: e.label, text: body, skipped: !!(d && d.skip), reason: d && d.skip });
    }
  }
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const skipped = shuffle(pool.filter((x) => x.skipped)), other = shuffle(pool.filter((x) => !x.skipped));
  const picked = [...skipped.slice(0, Math.ceil(SPOT_N * 0.6)), ...other].slice(0, SPOT_N);
  return { picked, pool: pool.length, skippedPool: skipped.length };
}

async function spotCheck(ctx, samples) {
  const { claudeBin, vault, env, logLine, run } = ctx;
  const body = samples.map((s, i) => `=== [E${i + 1}] ${s.rel}${s.label ? ` · ${s.label}` : ''} ===\n${s.text.slice(0, 3500)}`).join('\n\n');
  const prompt = [
    'You are the vault\'s verifier. Your working directory is the vault root. For each raw entry below, decide whether the wiki (wiki/**) already states its substantive facts: decisions, dates, statuses, numbers, ticket IDs, asks, new people.',
    'Use Grep on wiki/ for the entry\'s specific terms (names, ticket IDs, distinctive numbers or phrases) and Read only the matching lines or sections. Judge by what the wiki says, not by whether the page cites the raw file.',
    'Verdicts: covered (the substantive facts are in the wiki), partial (some are, name what is missing), missing (the wiki lacks them), trivial (nothing here worth storing: chatter, stubs, bare links).',
    'Reply with exactly one final line, nothing after it:',
    'VERDICTS: [{"id":"E1","verdict":"covered|partial|missing|trivial","note":"under 25 words: the wiki path that has it, or what is missing"}]',
    '', body,
  ].join('\n');
  let calls = 0;
  const r = await claudeStream(claudeBin, [
    '-p', prompt, '--model', 'sonnet', '--output-format', 'stream-json', '--verbose',
    '--allowedTools', 'Read(./wiki/**),Glob,Grep', '--tools', 'Read,Glob,Grep',
    '--disallowedTools', 'Agent,Task,Write,Edit,NotebookEdit,Bash',
    '--permission-prompts', 'none', '--setting-sources', 'user',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--max-budget-usd', String(SPOT_BUDGET), '--no-session-persistence',
  ], { cwd: vault, env, timeoutMs: 15 * 60000, onEvent: (ev) => { if (ev.type === 'assistant') for (const p of (ev.message && ev.message.content) || []) if (p.type === 'tool_use') calls++; } });
  const p = r.result;
  const cost = (p && p.total_cost_usd) || 0;
  if (!p) return { error: `claude exited ${r.code}`, cost };
  if (p.subtype === 'error_max_budget_usd') return { error: `hit the $${SPOT_BUDGET} budget`, cost };
  const m = String(p.result || '').match(/VERDICTS:\s*(\[[\s\S]*\])\s*$/);
  let v; try { v = m && JSON.parse(m[1]); } catch {}
  if (!v) return { error: 'no VERDICTS line', cost };
  logLine(run, `  spot-check: ${calls} tool calls, $${cost.toFixed(2)}`);
  return { verdicts: v, cost };
}

// --- the run -------------------------------------------------------------------

async function runVerify(run, ctx) {
  const { vault, logLine, finish } = ctx;
  const log = (s) => logLine(run, s);
  const findings = [];

  // 1. Lint (dead links, raw purity, annotations in raw).
  const lint = await bash(path.join(vault, 'docs', 'audits', 'linkrot-lint.sh'), vault);
  const lintRes = ctx.summarizeLint(lint.out, lint.code);
  log(`lint: ${lintRes.summary}`);
  if (lintRes.status === 'error') findings.push(`lint: ${lintRes.summary}`);

  // 2. Wiki structure.
  const w = wikiChecks(vault);
  log(`wiki: ${w.pages} pages · ${w.bad.length} frontmatter/tag violation(s) · ${w.unindexed.length} not in index.md · ${w.stale.length} with a newer cited source`);
  for (const b of w.bad.slice(0, 8)) log(`  frontmatter: ${b}`);
  for (const u of w.unindexed.slice(0, 8)) log(`  not indexed: ${u}`);
  for (const s of w.stale.slice(0, 8)) log(`  stale: ${s.rel} (updated ${s.updated}, newest source ${s.newest})`);
  if (w.bad.length) findings.push(`${w.bad.length} frontmatter/tag violation(s)`);
  // Missing index lines are mechanical to fix, so fix them rather than report them forever.
  const indexed = w.unindexed.length ? addToIndex(vault, w.unindexed) : [];
  if (indexed.length) log(`index: added ${indexed.length} page(s) to wiki/index.md`);
  const stillOut = w.unindexed.filter((u) => !indexed.includes(u));
  if (stillOut.length) findings.push(`${stillOut.length} page(s) missing from the index`);

  // 3. Raw that changed after it was ingested.
  const ch = changedSinceIngest(vault);
  log(`ingest ledger: ${ch.tracked} file(s) tracked · ${ch.changed.length} changed since ingested (the next ingest picks them up)`);

  // 3b. Workspace memory stores. Claude Code writes memories straight into the
  // vault, so there is no sync to run; the risk is a store that is NOT bound
  // (a new repo whose memories live only in ~/.claude, as switchboard did until
  // 07-21) and is never ingested. The dry run reads only.
  const bind = await bash(path.join(vault, 'docs', 'audits', 'bind-project-memory.sh'), vault);
  const reach = Number((bind.out.match(/raw memories reachable from vault root: (\d+)/) || [])[1] || 0);
  const drift = bind.out.split('\n').filter((l) => /^\s*(MIGRATE|ADOPT|MERGE|BIND|FAIL)\b/.test(l)).map((l) => l.trim());
  const clean = bind.code === 0 && /STATUS: dry run clean/.test(bind.out) && !drift.length;
  log(`memory stores: ${reach} memories reachable · ${clean ? 'all bound' : `${drift.length || 'unknown'} store(s) need binding`}`);
  for (const d of drift.slice(0, 8)) log(`  ${d}`);
  if (!clean) findings.push(`memory stores: ${drift.length ? drift.length : 'bind check failed'}; run docs/audits/bind-project-memory.sh --apply`);

  // 4. Contradictions into Needs-You.md.
  const needsPath = path.join(vault, 'Needs-You.md');
  const items = parseNeedsYou(fs.existsSync(needsPath) ? fs.readFileSync(needsPath, 'utf8') : '');
  const nc = newContradictions(vault);
  let added = 0;
  for (const c of nc.items) {
    const id = `c-${sha7(c.text.toLowerCase())}`;
    if (items.has(id)) continue;
    items.set(id, { id, date: c.date, text: c.text, boxes: CONTRA_BOXES.map((label) => ({ on: false, label })) });
    added++;
  }
  log(`contradictions: ${added} new in the queue`);

  // 5. Spot-check (model).
  let cost = 0, spot = null;
  const { picked, pool, skippedPool } = pickSamples(vault);
  if (!picked.length) log('spot-check: no ingested raw to sample yet');
  else {
    log(`spot-check: ${picked.length} of ${pool} candidate entries (${skippedPool} were judged "adds nothing")`);
    const res = await spotCheck({ ...ctx, run }, picked);
    cost += res.cost || 0;
    if (res.error) { log(`spot-check failed: ${res.error}`); findings.push(`spot-check failed: ${res.error}`); }
    else {
      const tally = {};
      for (const v of res.verdicts) {
        tally[v.verdict] = (tally[v.verdict] || 0) + 1;
        const s = picked[Number(String(v.id).replace(/\D/g, '')) - 1];
        if (!s) continue;
        log(`  ${v.id} ${String(v.verdict).padEnd(8)} ${s.rel}${s.skipped ? ' (was skipped)' : ''}: ${v.note || ''}`);
        if (v.verdict === 'missing' || v.verdict === 'partial') {
          const id = `g-${sha7(`${s.rel}${s.text.slice(0, 200)}`)}`;
          if (!items.has(id)) items.set(id, { id, date: new Date().toISOString().slice(0, 10), text: `${s.rel}${s.label ? ` · ${s.label}` : ''}: ${v.note || v.verdict}\n> ${s.text.replace(/\s+/g, ' ').slice(0, 220)}…`, boxes: GAP_BOXES.map((label) => ({ on: false, label })) });
        }
      }
      spot = tally;
      if ((tally.missing || 0) + (tally.partial || 0)) findings.push(`spot-check: ${tally.missing || 0} missing, ${tally.partial || 0} partial of ${res.verdicts.length}`);
    }
  }

  fs.writeFileSync(needsPath, renderNeedsYou(items, appliedIds(vault)));
  fs.mkdirSync(path.dirname(nc.statePath), { recursive: true });
  fs.writeFileSync(nc.statePath, JSON.stringify({ offset: nc.offset, at: new Date().toISOString() }));
  const openN = [...items.values()].filter((i) => !i.boxes.some((b) => b.on)).length;
  log(`Needs-You.md: ${openN} open item(s)`);

  const bits = [lintRes.summary === 'no findings' ? null : `lint: ${lintRes.summary}`, ...findings.filter((f) => !f.startsWith('lint')), openN ? `${openN} item(s) in Needs-You.md` : null,
    spot ? `spot-check ${Object.entries(spot).map(([k, n]) => `${n} ${k}`).join(', ')}` : null].filter(Boolean);
  finish(run, findings.length || lintRes.status === 'warn' || openN ? 'warn' : 'ok', bits.join(' · ') || 'all checks clean',
    { lint: lintRes.summary, frontmatter: w.bad, unindexed: w.unindexed, stale: w.stale.slice(0, 40), changedSinceIngest: ch.changed, memoryStores: { reachable: reach, drift }, spot }, cost);
}

module.exports = { runVerify, parseNeedsYou, renderNeedsYou, appliedIds, wikiChecks, newContradictions, pickSamples };
