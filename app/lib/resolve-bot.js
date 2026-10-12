// Resolve bot: turns the owner's ticks in Needs-You.md into wiki changes.
//
//   Needs-You.md ticks ──▶ not yet applied? (.bot/state/needs-applied.json)
//     │
//     ├─ "both are out of date, ignore" / "already covered, ignore" ─▶ recorded, no change
//     ├─ "re-ingest this file"  ─▶ one named-file Ingest run for all of them,
//     │                            each file carrying the verifier's note as a hint
//     └─ "the first/second claim is right" ─▶ one Sonnet call per item: Grep the wiki
//            for the losing claim, reply with EDIT blocks ─▶ code applies them
//            (EDIT only, wiki/ only, OLD must match exactly once) ─▶ backup, write,
//            stamp updated: ─▶ log.md "resolve" entry
//
// Same rule as everywhere else: the model proposes text, code decides what lands.
// Two boxes ticked on one item is ambiguous, so it is left alone and flagged.
// Originals are copied to .bot/state/resolve-backup/<run>/ before any write.

const fs = require('fs');
const path = require('path');
const { parseNeedsYou, renderNeedsYou, appliedIds } = require('./verify-bot');
const { parseBlocks, applyBlocks, stampFrontmatter } = require('./ingest');
const { claudeCall } = require('./claude-call');

const ITEM_BUDGET = 1;
const RUN_BUDGET = 6;
const MAX_ATTEMPTS = 2;
const RAW_PATH = /^((?:slack|gdrive|gcal|notion|linear|projects)\/[^\s:·]+\.md)/;

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

function contradictionPrompt(item, verdict, today) {
  const [first, second] = item.text.split(/\s+vs\.?\s+/i);
  return [
    "You are resolving a contradiction in the owner's wiki. The owner has decided which claim is right. Your working directory is the vault root.",
    '',
    `Contradiction (flagged by ingest on ${item.date}):`,
    item.text,
    '',
    second
      ? `The FIRST claim is: ${first.trim()}\nThe SECOND claim is: ${second.trim()}`
      : 'The two claims are the parts before and after "vs" above.',
    `The owner says: ${verdict}.`,
    '',
    'Task: make the wiki (wiki/**) agree with the owner. Grep wiki/ for the distinctive terms of the WRONG claim (names, dates, numbers, ticket IDs) to find every page that states it. Read raw files (slack/, linear/, notion/, gdrive/, projects/) only if you need the exact wording, date or source of the right claim.',
    `For each place the wrong claim stands, replace it with the right one and add " (owner confirmed ${today})" after the corrected sentence. Change only the claim, not the surrounding text. Write the corrected sentence about 80% to ASD-STE100: short, common words, active voice. If the right claim already stands everywhere and the wrong one is nowhere in wiki/, change nothing.`,
    '',
    'You cannot write files. Reply with EDIT blocks only (no APPEND, no FILE):',
    '    <<<EDIT wiki/partners/example.md',
    '    <<<OLD',
    '    <exact current line(s), copied WITHOUT any "123:" line-number prefix; must be unique in the file>',
    '    <<<NEW',
    '    <replacement>',
    '    <<<END>>>',
    'End with exactly one line, nothing after it:',
    'RESULT: {"pages":["wiki/<path>.md"],"note":"under 25 words: what you changed, or why nothing needed changing"}',
  ].join('\n');
}

async function resolveContradiction(ctx, item, verdict) {
  const { claudeBin, vault, env } = ctx;
  const today = new Date().toISOString().slice(0, 10);
  const r = await claudeCall({ claudeBin, vault, env }, {
    prompt: contradictionPrompt(item, verdict, today), model: 'sonnet',
    budget: ITEM_BUDGET, timeoutMs: 10 * 60000,
  });
  const p = r.result;
  const cost = (p && p.total_cost_usd) || 0;
  if (!p) return { error: `claude exited ${r.code}`, cost };
  if (p.subtype === 'error_max_budget_usd') return { error: `hit the $${ITEM_BUDGET} budget`, cost };
  const text = String(p.result || '');
  const m = text.match(/RESULT:\s*(\{[\s\S]*\})\s*$/);
  let result; try { result = m && JSON.parse(m[1]); } catch {}
  if (!result) return { error: 'no RESULT line', cost };
  const all = parseBlocks(text);
  const ops = all.filter((o) => o.kind === 'edit');
  const refused = all.length - ops.length;
  const { pages, applied, misses } = applyBlocks(vault, ops);
  if (refused) misses.push(`${refused} APPEND/FILE block(s) refused: resolve may only EDIT`);
  return { pages, applied: [...applied], misses, note: result.note || '', proposed: ops.length, cost };
}

const choiceOf = (item) => item.boxes.filter((b) => b.on).map((b) => b.label);

async function runResolve(run, ctx) {
  const { vault, logLine, finish } = ctx;
  const log = (s) => logLine(run, s);
  const needsPath = path.join(vault, 'Needs-You.md');
  if (!fs.existsSync(needsPath)) return finish(run, 'ok', 'no Needs-You.md yet');
  const items = parseNeedsYou(fs.readFileSync(needsPath, 'utf8'));
  const statePath = path.join(vault, '.bot', 'state', 'needs-applied.json');
  const state = readJson(statePath, {});
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const stamp = now.replace(/[:.]/g, '-');

  // New answers, plus answers the owner changed since they were applied.
  const same = (i) => state[i.id] && JSON.stringify(state[i.id].choice) === JSON.stringify(choiceOf(i));
  const todo = [...items.values()].filter((i) => choiceOf(i).length && !(same(i) && state[i.id].done));
  if (!todo.length) return finish(run, 'ok', 'no new answers in Needs-You.md');
  log(`${todo.length} answered item(s) to apply`);

  let cost = 0;
  const done = [], failed = [], reingest = {};
  const note = (item, line) => { item.text = `${item.text}\n_${line}_`; };
  const record = (item, ok, result) => {
    const prev = same(item) ? state[item.id] : { attempts: 0 };
    const giveUp = !ok && prev.attempts + 1 >= MAX_ATTEMPTS;
    state[item.id] = { ...prev, choice: choiceOf(item), at: now, ok, done: ok || giveUp, attempts: prev.attempts + 1, result };
    // Applied: the claim quotes are not needed any more; the links stay (A7).
    if (ok) require('./claim-sources').dropQuotes(vault, item.id);
    if (giveUp) note(item, `Could not apply after ${MAX_ATTEMPTS} tries (${result}). Fix the page by hand, or tick a different box.`);
  };

  for (const item of todo) {
    const choice = choiceOf(item);
    if (choice.length > 1) { log(`${item.id}: ${choice.length} boxes ticked, untick all but one`); failed.push(`${item.id} ambiguous`); continue; }
    const c = choice[0];
    if (/ignore$/.test(c)) {
      record(item, true, 'no change (owner chose ignore)');
      note(item, `Applied ${today}: no change.`);
      done.push(`${item.id} ignored`); log(`${item.id}: ${c} → no change`);
      continue;
    }
    if (c === 're-ingest this file') {
      const rel = (item.text.match(RAW_PATH) || [])[1];
      if (!rel || !fs.existsSync(path.join(vault, rel))) { record(item, false, 'could not find the raw file named in this item'); failed.push(`${item.id} no file`); log(`${item.id}: no raw file found in the item text`); continue; }
      reingest[rel] = (reingest[rel] ? `${reingest[rel]} / ` : '') + item.text.split('\n')[0].replace(RAW_PATH, '').replace(/^[^:]*:\s*/, '').slice(0, 300);
      item._rel = rel;
      continue;
    }
    // A contradiction answer.
    if (cost >= RUN_BUDGET) { log(`${item.id}: run budget $${RUN_BUDGET} reached; left for the next run`); continue; }
    log(`${item.id}: "${c}" → asking sonnet which pages state the losing claim…`);
    const res = await resolveContradiction(ctx, item, c);
    cost += res.cost || 0;
    if (res.error) { record(item, false, res.error); failed.push(`${item.id} ${res.error}`); log(`  failed: ${res.error} ($${(res.cost || 0).toFixed(2)})`); continue; }
    for (const mi of res.misses) log(`  not applied: ${mi}`);
    if (res.proposed && !res.applied.length) {
      record(item, false, `no edit applied: ${res.misses[0] || 'unknown'}`);
      failed.push(`${item.id} edits did not apply`); continue;
    }
    // Back up, write, stamp updated:.
    for (const rel of res.applied) {
      const abs = path.join(vault, rel);
      const bak = path.join(vault, '.bot', 'state', 'resolve-backup', stamp, rel);
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.copyFileSync(abs, bak);
      fs.writeFileSync(abs, stampFrontmatter(res.pages.get(rel), [], today));
    }
    const what = res.applied.length ? `edited ${res.applied.join(', ')}` : `no change needed (${res.note})`;
    record(item, true, what);
    note(item, `Applied ${today}: ${what}.`);
    done.push(`${item.id} ${res.applied.length ? `${res.applied.length} page(s)` : 'no change'}`);
    log(`  ${what} · $${(res.cost || 0).toFixed(2)}${res.note ? ` · ${res.note}` : ''}`);
  }

  // Named re-ingest, once, for every file the owner asked about.
  const rels = Object.keys(reingest);
  let ingestRun = null;
  if (rels.length) {
    log(`re-ingesting ${rels.length} file(s): ${rels.join(', ')}`);
    ingestRun = await ctx.runBot('ingest', { files: rels, hints: reingest });
    cost += ingestRun.costUsd || 0;
    const ok = ingestRun.status !== 'error';
    log(`ingest: ${ingestRun.status} · ${ingestRun.summary}`);
    for (const item of todo.filter((i) => i._rel)) {
      record(item, ok, ok ? `re-ingested (${ingestRun.summary})` : `ingest failed: ${ingestRun.summary}`);
      if (ok) { note(item, `Applied ${today}: re-ingested ${item._rel}.`); done.push(`${item.id} re-ingested`); } else failed.push(`${item.id} ingest ${ingestRun.status}`);
    }
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  fs.writeFileSync(needsPath, renderNeedsYou(items, appliedIds(vault)));

  if (done.length) {
    const lines = todo.filter((i) => state[i.id] && state[i.id].at === now).map((i) => `- ${i.id} (${choiceOf(i).join(', ')}): ${state[i.id].result}`);
    fs.appendFileSync(path.join(vault, 'wiki', 'log.md'), `\n## [${today} ${now.slice(11, 16)}] resolve | ${done.length} owner answer(s) from Needs-You.md applied\n${lines.join('\n')}\n`);
  }
  finish(run, failed.length ? 'warn' : 'ok', `${done.length} applied${failed.length ? ` · ${failed.length} not: ${failed.join(', ')}` : ''}`, { done, failed, backup: `.bot/state/resolve-backup/${stamp}` }, cost);
}

module.exports = { runResolve, contradictionPrompt };
