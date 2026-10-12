// Restructure bot: turns an append-log wiki page (the two largest were 337KB
// and 221KB) into a HUB page plus a verbatim HISTORY companion. Supervised: it
// stages, the owner reviews and ticks a box, the next run applies.
//
//   pick page (largest over 150KB with no -history companion, or body.page)
//     ▼
//   code: split on "## " headings ─▶ reference sections stay on the hub
//                                  ─▶ dated narrative / open-question / contradiction
//                                     sections move VERBATIM to <slug>-history.md, in date order
//                                  ─▶ Related / Sources merged (exact-duplicate lines once)
//     ▼
//   one Opus call reads everything and writes only three short hub sections:
//     Current state (as of today) · Timeline · Open questions (still open, deduped)
//     every line must link a raw file or a heading on the history page; others dropped
//     ▼
//   gate: every non-blank line of the old page appears in hub ∪ history
//     ▼
//   stage in .bot/restructure/<slug>/ (hub.md, history.md, old.md, report.md with
//   an "apply" tick-box) ─▶ owner ticks ─▶ next run: page unchanged since staging?
//   back up, write both, index the history page, log.md entry
//
// Code moves every byte; the model only adds a summary on top. Nothing is lost,
// and a page that ingest changed after staging is re-staged, never overwritten.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { claudeCall } = require('./claude-call');
const { splitFrontmatter } = require('./ingest');
const { addToIndex } = require('./wiki-index');

const MIN_BYTES = 150000;
const BUDGET = 8;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DATED = /\d{4}-\d{2}-\d{2}|\b\d{2}-\d{2}\b|\badded\b.*\bingest\b|\bingest\b|→|\b(jan|feb|mar|apr|may|june?|july?|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b(early|mid|late)[- ](jan|feb|mar|apr|may|june?|july?|aug|sept?|oct|nov|dec)/i;
const HISTORY_NAMES = /^(Recent activity|Contradictions|Open questions|Open contract gaps)/i;
const TAIL_NAMES = /^(Related|Sources)\b/i;
// Reference material even when its heading carries a date ("V1 scope (locked at onsite 2026-04-21)").
const REFERENCE_NAMES = /\b(scope|origin|shape|mapping|security review|DRIs|channels|gotchas)\b/i;

// Top-level sections, respecting code fences.
function sections(body) {
  const out = [];
  let cur = { head: null, lines: [] }, fence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) { out.push(cur); cur = { head: line.slice(3).trim(), lines: [line] }; continue; }
    cur.lines.push(line);
  }
  out.push(cur);
  return out.map((s, i) => ({ ...s, i, text: s.lines.join('\n') }));
}

function dateKey(head, year) {
  let m = head.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = head.match(/\b(\d{2})-(\d{2})\b/);
  if (m) return `${year}-${m[1]}-${m[2]}`;
  m = head.match(/\b(jan|feb|mar|apr|may|june?|july?|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i);
  if (m) return `${year}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function classify(secs) {
  return secs.map((s) => {
    if (s.head === null) return { ...s, kind: 'title' };
    if (TAIL_NAMES.test(s.head)) return { ...s, kind: 'tail' };
    // "(added 2026-08-28 ingest)" marks an ingest-appended narrative, whatever else the heading says.
    if (/\badded\b[^)]*\bingest\b/i.test(s.head)) return { ...s, kind: 'history' };
    if (REFERENCE_NAMES.test(s.head) && !HISTORY_NAMES.test(s.head)) return { ...s, kind: 'reference' };
    if (HISTORY_NAMES.test(s.head) || DATED.test(s.head)) return { ...s, kind: 'history' };
    return { ...s, kind: 'reference' };
  });
}

function pickPage(vault) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.md')) out.push(p); } };
  walk(path.join(vault, 'wiki'));
  return out.map((abs) => ({ rel: path.relative(vault, abs), size: fs.statSync(abs).size }))
    .filter((x) => x.size >= MIN_BYTES && !x.rel.endsWith('-history.md') && !['wiki/index.md', 'wiki/log.md'].includes(x.rel)
      && !fs.existsSync(path.join(vault, x.rel.replace(/\.md$/, '-history.md'))))
    .sort((a, b) => b.size - a.size);
}

const SYNTH = (name, histRel, today, headings) => `You are restructuring the owner's wiki page for ${name}. It grew into a long append-only log. Code has already moved every dated section, verbatim, to a history page (${histRel}); nothing will be lost. Your job is to write ONLY the short summary that goes on top of the hub page, from the full page text below.

Write exactly these three sections and nothing else:

## Current state (as of ${today})
8 to 20 bullets: what is true NOW. Status, live dates, what is shipped, what is blocked and on whom, the next milestone. Where the log shows a fact changed, state the latest version only. Bold the key noun of each bullet.

## Timeline
One line per notable event, oldest first, at most 40 lines: "- YYYY-MM-DD: <what happened>". Use the dates in the text.

## Open questions
Only questions still open at the end of the log, deduplicated: "- [ ] <question> (<who owns it>)". Leave out anything the log later answers.

Every bullet must end with at least one link. Link the history heading it comes from, written exactly as [[${histRel.replace(/\.md$/, '')}#<heading text>]], or a raw file the text already cites ([[slack/2026-09-22]], [[linear/issues/PBYR-1234]] …). A bullet with no valid link is deleted by the runner. Plain sentences, no em dashes, no filler, no hedging. Write about 80% to ASD-STE100 Simplified Technical English: short sentences (about 20 words for prose, 15 for steps), common words with one meaning each, the same term for the same thing every time, active voice, one instruction per sentence, one idea per paragraph, no hedging words, keep articles. Keep a natural tone. Do not invent facts.

History headings you may link (exact text):
${headings.map((h) => `- ${h}`).join('\n')}

=== THE FULL PAGE ===
`;

function checkLinks(vault, text, histHeads, histRel) {
  let dropped = 0;
  const hist = histRel.replace(/\.md$/, '');
  const keep = text.split('\n').filter((line) => {
    if (!/^\s*(?:-|\d+\.)\s/.test(line)) return true;
    const links = [...line.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1]);
    const ok = links.length && links.every((l) => {
      const [p, anchor] = l.split('#');
      if (p === hist) return !anchor || histHeads.has(anchor.trim());
      return fs.existsSync(path.join(vault, `${p}.md`)) || fs.existsSync(path.join(vault, p));
    });
    if (!ok) dropped++;
    return ok;
  });
  return { text: keep.join('\n'), dropped };
}

const pick3 = (text) => {
  const grab = (re) => (text.match(re) || [])[0] || '';
  return {
    current: grab(/^## Current state[^\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/m).trim(),
    timeline: grab(/^## Timeline[^\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/m).trim(),
    open: grab(/^## Open questions[^\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/m).trim(),
  };
};

async function stage(run, ctx, rel, comments) {
  const { vault, logLine } = ctx;
  const log = (s) => logLine(run, s);
  const today = new Date().toLocaleDateString('en-CA'); // the owner's local date, not UTC
  const year = today.slice(0, 4);
  const old = read(path.join(vault, rel));
  const { fm, body } = splitFrontmatter(old);
  if (fm === null) throw new Error(`${rel} has no frontmatter`);
  const name = ((fm.match(/^name:\s*"?([^"\n]+)"?/m) || [])[1] || path.basename(rel, '.md')).trim();
  const histRel = rel.replace(/\.md$/, '-history.md');
  const secs = classify(sections(body));
  const ref = secs.filter((s) => s.kind === 'reference');
  let hist = secs.filter((s) => s.kind === 'history');
  const tail = secs.filter((s) => s.kind === 'tail');
  const title = secs.find((s) => s.kind === 'title');
  log(`${rel}: ${Math.round(old.length / 1024)}KB · ${ref.length} reference section(s) stay · ${hist.length} dated section(s) move to history · ${tail.length} Related/Sources block(s) merged`);

  // History in date order; an undated section keeps the date of the one before it.
  let last = '0000-00-00';
  hist = hist.map((s) => { const k = dateKey(s.head, year) || last; last = k; return { ...s, key: k }; })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i));
  // Duplicate headings would make anchors ambiguous; suffix later ones.
  const seen = new Map();
  hist = hist.map((s) => {
    const n = (seen.get(s.head) || 0) + 1; seen.set(s.head, n);
    if (n === 1) return s;
    const head = `${s.head} (${n})`;
    return { ...s, head, text: s.text.replace(/^## .*$/m, `## ${head}`) };
  });
  const histHeads = new Set(hist.map((s) => s.head));

  // Related + Sources: every line kept once.
  const merged = (re) => {
    const lines = [];
    for (const s of tail.filter((t) => re.test(t.head))) for (const l of s.lines.slice(1)) if (l.trim() && !lines.includes(l)) lines.push(l);
    return lines;
  };
  const related = merged(/^Related/i), sources = merged(/^Sources/i);

  // The model's three sections.
  // The owner's comments from the compare view, per section, if this is a re-stage.
  const notes = comments && Object.keys(comments).length
    ? `\nThe owner reviewed an earlier version of this split and asked for these changes. Follow them in the three sections you write:\n${Object.entries(comments).map(([h, t]) => `- On "${h}": ${t}`).join('\n')}\n\n`
    : '';
  const prompt = SYNTH(name, histRel, today, [...histHeads]) + notes + body;
  log(`asking opus for Current state / Timeline / Open questions (${Math.round(prompt.length / 1024)}KB in)…`);
  const r = await claudeCall({ claudeBin: ctx.claudeBin, vault, env: ctx.env }, {
    prompt, model: 'opus', tools: 'Read,Grep,Glob', allowed: 'Read(./wiki/**),Grep,Glob',
    budget: BUDGET, timeoutMs: 20 * 60000,
  });
  const p = r.result;
  const cost = (p && p.total_cost_usd) || 0;
  if (!p) throw Object.assign(new Error(`claude exited ${r.code}`), { cost });
  if (p.subtype === 'error_max_budget_usd') throw Object.assign(new Error(`hit the $${BUDGET} budget`), { cost });
  const three = pick3(String(p.result || ''));
  if (!three.current || !three.timeline) throw Object.assign(new Error('the answer lacked Current state or Timeline'), { cost });
  const checked = checkLinks(vault, [three.current, three.timeline, three.open || '## Open questions\n- None open.'].join('\n\n'), histHeads, histRel);
  log(`synthesis: $${cost.toFixed(2)} · ${checked.dropped} bullet(s) dropped for missing or dead links`);

  const fmOut = fm.replace(/^updated:.*$/m, `updated: ${today}`);
  const histName = `${name} — history`;
  const hub = [
    '---', fmOut, '---',
    title ? title.text.trimEnd() : `# ${name}`, '',
    `> Dated notes for this page live in [[${histRel.replace(/\.md$/, '')}]] (moved there verbatim on ${today}). This page holds what is true now.`, '',
    ...ref.filter((s) => /^Overview/i.test(s.head)).map((s) => s.text.trimEnd() + '\n'),
    checked.text.trim(), '',
    ...ref.filter((s) => !/^Overview/i.test(s.head)).map((s) => s.text.trimEnd() + '\n'),
    '## Related', `- [[${histRel.replace(/\.md$/, '')}]] — dated notes, oldest first`, ...related, '',
    '## Sources', ...sources, '',
  ].join('\n');
  const history = [
    '---', fmOut.replace(/^name:.*$/m, `name: ${JSON.stringify(histName)}`), '---',
    `# ${histName}`, '',
    `Dated notes for [[${rel.replace(/\.md$/, '')}]], oldest first. Moved here verbatim from the hub page on ${today}; new dated notes are appended here by ingest. The hub page holds the current state.`, '',
    ...hist.map((s) => s.text.trimEnd() + '\n'),
    '## Related', `- [[${rel.replace(/\.md$/, '')}]] — current state`, '',
    '## Sources', ...sources, '',
  ].join('\n');

  // Gate: every non-blank line of the old body is somewhere in the new pair.
  const union = new Set([...hub.split('\n'), ...history.split('\n')]);
  const renamed = new Set(secs.map((s) => s.lines[0]));
  const lost = body.split('\n').filter((l) => l.trim() && !union.has(l) && !(renamed.has(l) && /^## /.test(l)));
  // A heading may have been suffixed " (2)"; its text still exists on the history page.
  const reallyLost = lost.filter((l) => !(/^## /.test(l) && [...union].some((u) => u.startsWith(l))));
  if (reallyLost.length) throw Object.assign(new Error(`coverage gate: ${reallyLost.length} line(s) of the old page are in neither new page (first: ${JSON.stringify(reallyLost[0].slice(0, 120))})`), { cost });

  const dir = path.join(vault, '.bot', 'restructure', path.basename(rel, '.md'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hub.md'), hub);
  fs.writeFileSync(path.join(dir, 'history.md'), history);
  fs.writeFileSync(path.join(dir, 'old.md'), old);
  const report = [
    `# Restructure: ${rel}`, '',
    `Staged ${new Date().toISOString().slice(0, 16)}Z. Old page ${Math.round(old.length / 1024)}KB → hub ${Math.round(hub.length / 1024)}KB + history ${Math.round(history.length / 1024)}KB. Every line of the old page is in one of the two (checked).`,
    `Old page sha256: ${sha(old)}`, '',
    'Review `hub.md` and `history.md` in this folder. To apply, tick the box and run Restructure again. If ingest changes the page first, it is re-staged instead.', '',
    '- [ ] apply this restructure', '',
    '## Stays on the hub (verbatim)', ...ref.map((s) => `- ${s.head}`), '',
    `## Moves to ${histRel} (verbatim, date order)`, ...hist.map((s) => `- ${s.key} · ${s.head}`), '',
    '## New on the hub (opus)', checked.text.trim(), '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'report.md'), report);
  return { cost, dir: path.relative(vault, dir), hubKB: Math.round(hub.length / 1024), histKB: Math.round(history.length / 1024) };
}

function apply(ctx, rel, dir) {
  const { vault } = ctx;
  const report = read(path.join(dir, 'report.md'));
  const want = (report.match(/^Old page sha256: (\w+)/m) || [])[1];
  const cur = read(path.join(vault, rel));
  if (sha(cur) !== want) return { restage: true };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = path.join(vault, '.bot', 'state', 'restructure-backup', stamp);
  fs.mkdirSync(path.dirname(path.join(bak, rel)), { recursive: true });
  fs.copyFileSync(path.join(vault, rel), path.join(bak, rel));
  const histRel = rel.replace(/\.md$/, '-history.md');
  fs.writeFileSync(path.join(vault, rel), read(path.join(dir, 'hub.md')));
  fs.writeFileSync(path.join(vault, histRel), read(path.join(dir, 'history.md')));
  addToIndex(vault, [histRel]);
  const now = new Date().toISOString();
  fs.appendFileSync(path.join(vault, 'wiki', 'log.md'), `\n## [${now.slice(0, 10)} ${now.slice(11, 16)}] restructure | ${rel} split into a hub and ${histRel}\n- Dated sections moved verbatim; hub gained Current state / Timeline / Open questions. Original: ${path.relative(vault, bak)}/${rel}\n`);
  fs.renameSync(dir, `${dir}-applied-${stamp}`);
  return { applied: true, backup: path.relative(vault, bak) };
}

async function runRestructure(run, ctx, body = {}) {
  const { vault, logLine, finish } = ctx;
  const log = (s) => logLine(run, s);
  const root = path.join(vault, '.bot', 'restructure');
  // 1. A staged restructure: apply it if ticked, else wait for the owner.
  const staged = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => !d.includes('-applied-') && !d.includes('-stale-') && fs.existsSync(path.join(root, d, 'report.md'))) : [];
  for (const d of staged) {
    const dir = path.join(root, d);
    const rep = read(path.join(dir, 'report.md'));
    const rel = (rep.match(/^# Restructure: (\S+)/m) || [])[1];
    if (!/^- \[x\] apply this restructure/im.test(rep)) {
      if (!body.page) return finish(run, 'warn', `${rel} is staged and waiting for you: review .bot/restructure/${d}/ and tick "apply" in report.md`, { staged: rel });
      continue;
    }
    const res = apply(ctx, rel, dir);
    if (res.restage) { log(`${rel} changed since it was staged; re-staging`); fs.renameSync(dir, `${dir}-stale-${Date.now()}`); body = { ...body, page: rel }; break; }
    return finish(run, 'ok', `applied: ${rel} is now a hub + ${rel.replace(/\.md$/, '-history.md')} (original in ${res.backup})`, res);
  }
  // 2. Stage the next page.
  // A page named in the request must be a wiki page inside this vault.
  if (body.page && !(/^wiki\/[^\0]+\.md$/.test(body.page) && !body.page.split('/').includes('..') && path.resolve(vault, body.page).startsWith(path.join(vault, 'wiki') + path.sep))) return finish(run, 'error', `not a wiki page: ${body.page}`);
  const target = body.page || (pickPage(vault)[0] || {}).rel;
  if (!target) return finish(run, 'ok', `no wiki page over ${MIN_BYTES / 1000}KB without a history companion`);
  if (!fs.existsSync(path.join(vault, target))) return finish(run, 'error', `no such page: ${target}`);
  try {
    const r = await stage(run, ctx, target, body.comments);
    finish(run, 'warn', `staged ${target}: hub ${r.hubKB}KB + history ${r.histKB}KB. Review ${r.dir}/ and tick "apply" in report.md, then run Restructure again`, r, r.cost);
  } catch (e) {
    finish(run, 'error', e.message, null, e.cost || 0);
  }
}

module.exports = { runRestructure, sections, classify, dateKey, pickPage };
