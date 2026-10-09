// Brief bot: a read-only "today" page. No model: every line is read from files
// the other bots already wrote, so it costs nothing and cannot invent anything.
//
//   gcal/<today>.md  ─┐
//   wiki/ (route.js) ─┤
//   MEMORY.md RESUME ─┼──▶ Brief.md (vault root) + run.detail.markdown
//   Needs-You.md     ─┤
//   bot runs, ledgers ┘

const fs = require('fs');
const path = require('path');
const { buildIndex } = require('./route');
const { readOwner, getConfig } = require('./config');
const { dayOf } = require('./time');
const { parseNeedsYou } = require('./verify-bot');
const { claudeCall } = require('./claude-call');
const { splitFrontmatter, fmField } = require('./ingest');

const SYNTH_BUDGET = 1;
const PACKET_BYTES = 40000;

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const localDate = (vault, d = new Date()) => dayOf(d, getConfig(vault).owner.timezone);
const ago = (iso) => {
  const h = (Date.now() - Date.parse(iso)) / 36e5;
  return Number.isNaN(h) ? 'never' : h < 1 ? 'just now' : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
};

// The calendar file's events: title, time, non-declined attendees, description.
function parseEvents(text) {
  return text.split(/^## /m).slice(1).map((blk) => {
    const [head, ...rest] = blk.split('\n');
    const m = head.match(/^(.+?)\s*·\s*(.+)$/);
    const attendees = [];
    for (const a of ((rest.join('\n').match(/^- \*\*Attendees:\*\* (.+)$/m) || [])[1] || '').split(/,\s*(?=[^\s,]+@)/)) {
      const x = a.match(/^(\S+@\S+) \((\w+)\)/);
      if (x && x[2] !== 'declined') attendees.push(x[1]);
    }
    const link = (rest.join('\n').match(/^- \*\*Location:\*\* (\S+)/m) || [])[1] || '';
    const body = rest.filter((l) => !l.startsWith('- **')).join('\n').trim();
    return { time: m ? m[1] : '', title: m ? m[2].trim() : head.trim(), attendees, link, body };
  });
}

// jane.doe@example.com -> wiki/people/jane-doe, only if that page exists.
function peopleFor(vault, emails, ownerEmail) {
  const out = [];
  for (const e of emails) {
    if (e === ownerEmail) continue;
    const slug = e.split('@')[0].replace(/\./g, '-');
    if (fs.existsSync(path.join(vault, 'wiki', 'people', `${slug}.md`))) out.push(`wiki/people/${slug}`);
  }
  return out;
}

// RESUME memories that still say something is owed (not CLOSED).
function owedFromMemory(vault) {
  const stores = fs.readdirSync(path.join(vault, 'projects')).filter((d) => fs.existsSync(path.join(vault, 'projects', d, 'MEMORY.md')));
  const lines = stores.flatMap((d) => read(path.join(vault, 'projects', d, 'MEMORY.md')).split('\n')).filter((l) => /^- \[RESUME/.test(l));
  const owed = lines.filter((l) => /\bowed\b|NOT sent|not posted|nothing posted|not confirmed posted/i.test(l));
  const short = (l) => { const m = l.match(/^- \[(.+?)\]\(.+?\) — (.+)$/); return m ? `${m[1].replace(/^RESUME:\s*/, '')}: ${m[2]}` : l.slice(2); };
  return { owed: owed.map(short), open: lines.length };
}

function statusLines(vault, ctx) {
  const rows = [];
  for (const b of ['sync-slack', 'sync-gcal', 'sync-gdrive', 'sync-notion', 'sync-linear', 'ingest', 'verify']) {
    const r = ctx.latestFor(b);
    rows.push(`- ${b.replace('sync-', 'sync ')}: ${r ? `${r.status} · ${ago(r.endedAt || r.startedAt)} · ${r.summary}` : 'never run'}`);
  }
  const lastIngest = read(path.join(vault, 'wiki', '.last-ingest')).trim();
  const pend = ['linear', 'notion'].map((s) => {
    try { return [s, JSON.parse(read(path.join(vault, '.bot', 'state', `${s}-pending.json`)) || '[]').length]; } catch { return [s, 0]; }
  }).filter(([, n]) => n);
  rows.push(`- wiki last ingested ${lastIngest ? ago(lastIngest) : 'never'}${pend.length ? ` · pending: ${pend.map(([s, n]) => `${n} ${s}`).join(', ')}` : ''}`);
  try {
    const held = JSON.parse(read(path.join(vault, '.bot', 'state', 'ingest-held.json')) || '{}');
    const keys = Object.keys(held);
    if (keys.length) rows.push(`- ingest holding: ${keys.join(', ')}`);
  } catch {}
  return rows;
}


// --- what came in -------------------------------------------------------------
// Code picks the candidates; the model only ranks and explains them. Every item
// carries the wikilink of the raw file it came from, so each claim can be checked.

const dayStr = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5);

// Slack: mentions of the owner in the newest two synced days, plus the owner's own
// threads that someone else replied to.
function slackItems(vault) {
  const dir = path.join(vault, 'slack');
  const files = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().slice(-2);
  const out = [];
  // The owner's own replies don't count as someone else replying.
  const first = (readOwner(vault).name || '').split(/\s+/)[0];
  const notOwner = first ? new RegExp(`\\n\\s+- \\*\\*(?!${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`) : /\n\s+- \*\*/;
  for (const f of files) {
    const text = read(path.join(dir, f));
    const [, sent = '', ments = ''] = text.split(/^## (?:Sent Messages|Mentions & Tags)\s*$/m);
    const blocks = (sec, kind) => sec.split(/\n(?=- \*\*\d)/).map((b) => b.trim()).filter((b) => b.startsWith('- **'))
      .filter((b) => kind === 'mention' ? !/^- \*\*[^*]+\*\* · DM with Linear/.test(b) : notOwner.test(b))
      .map((b) => `[[slack/${f.slice(0, 10)}]] ${kind}: ${b.replace(/\(https?:[^)]*\)|\[↗\]\([^)]*\)/g, '').replace(/\s+/g, ' ').slice(0, 420)}`);
    out.push(...blocks(ments, 'mention'), ...blocks(sent, 'thread-with-replies'));
  }
  return out.slice(0, 70);
}

// Linear: open issues assigned to the owner, and anything of theirs touched this week.
function linearItems(vault, ownerName) {
  const dir = path.join(vault, 'linear', 'issues');
  const cut = dayStr(daysAgo(14));
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const { fm } = splitFrontmatter(read(path.join(dir, f)));
    if (!fm || fmField(fm, 'assignee') !== ownerName) continue;
    const state = fmField(fm, 'state') || '';
    const upd = (fmField(fm, 'updated_at') || '').slice(0, 10);
    if (/^(Done|Canceled|Cancelled|Duplicate)/i.test(state) || upd < cut) continue;
    out.push({ upd, line: `[[linear/issues/${f.replace(/\.md$/, '')}]] ${fmField(fm, 'identifier')} ${fmField(fm, 'title')} · ${state} · P${fmField(fm, 'priority')} · updated ${upd}` });
  }
  const first = ownerName.split(' ')[0];
  const assigned = out.sort((a, b) => (a.upd < b.upd ? 1 : -1)).slice(0, 20).map((x) => x.line);
  // Anything touched in the last 3 days whose body or comments name the owner.
  const recent = [];
  const cut3 = dayStr(daysAgo(3));
  for (const f of fs.readdirSync(dir)) {
    const text = read(path.join(dir, f));
    const { fm } = splitFrontmatter(text);
    const upd = fm ? (fmField(fm, 'updated_at') || '').slice(0, 10) : '';
    if (!fm || upd < cut3 || fmField(fm, 'assignee') === ownerName || !new RegExp(`@?${first}\\b`).test(text)) continue;
    recent.push({ upd, line: `[[linear/issues/${f.replace(/\.md$/, '')}]] ${fmField(fm, 'identifier')} ${fmField(fm, 'title')} · ${fmField(fm, 'state')} · assignee ${fmField(fm, 'assignee')} · updated ${upd} · names the owner` });
  }
  return [...assigned, ...recent.sort((a, b) => (a.upd < b.upd ? 1 : -1)).slice(0, 15).map((x) => x.line)];
}

// Notion: pages edited in the last 3 days that mention or involve the owner.
function notionItems(vault) {
  const dir = path.join(vault, 'notion', 'pages');
  const cut = dayStr(daysAgo(3));
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const { fm } = splitFrontmatter(read(path.join(dir, f)));
    if (!fm) continue;
    const fmWhen = (fmField(fm, 'last_edited_time') || '').slice(0, 10);
    // Database rows often have no edit time; the file changes only when the content does.
    const when = /^\d{4}-\d{2}-\d{2}$/.test(fmWhen) ? fmWhen : dayStr(fs.statSync(path.join(dir, f)).mtime);
    if (when < cut) continue;
    out.push({ when, line: `[[notion/pages/${f.replace(/\.md$/, '')}]] ${fmField(fm, 'title')} · ${fmField(fm, 'parent_database') || 'page'} · edited ${when}${/^\d{4}/.test(fmWhen) ? '' : ' (file changed)'} · ${(fm.match(/in_scope_reasons: \[(.*?)\]/) || [, ''])[1]}` });
  }
  return out.sort((a, b) => (a.when < b.when ? 1 : -1)).slice(0, 25).map((x) => x.line);
}

function freshness(vault) {
  const newest = (k) => (fs.readdirSync(path.join(vault, k)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().pop() || '').slice(0, 10);
  return ['slack', 'linear', 'notion', 'gcal', 'gdrive'].map((k) => {
    // Slack's watermark is advisory (the rolling window does the work); its newest day file is the real answer.
    if (k === 'slack') return `slack: newest day synced ${newest('slack') || 'none'}`;
    const v = read(path.join(vault, k, '.last-sync')).trim();
    return `${k} synced through ${v ? v.slice(0, 16).replace('T', ' ') + 'Z' : 'never'}`;
  });
}

// Memories written or changed in the last 3 days, in every workspace store. These are
// the owner's own working notes (decisions, what is parked, what is owed).
function memoryItems(vault) {
  const root = path.join(vault, 'projects');
  const since = Date.now() - 3 * 864e5;
  const out = [];
  for (const store of fs.readdirSync(root)) {
    const dir = path.join(root, store);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs < since) continue;
      const { fm } = splitFrontmatter(read(path.join(dir, f)));
      out.push({ t: st.mtimeMs, line: `[[projects/${store}/${f.replace(/\.md$/, '')}]] (${store}) ${(fmField(fm, 'description') || fmField(fm, 'name') || f).slice(0, 220)} · changed ${dayStr(st.mtime)}` });
    }
  }
  return out.sort((a, b) => b.t - a.t).slice(0, 20).map((x) => x.line);
}

function buildPacket(vault, ownerName, eventsMd, owed) {
  const sec = (title, lines) => `## ${title}\n${lines.length ? lines.map((l) => `- ${l}`).join('\n') : '(none)'}`;
  let packet = [
    sec('Calendar today', eventsMd.map((l) => l.replace(/\n\s*/g, ' '))),
    sec('Slack: mentions and threads with replies, newest two synced days', slackItems(vault)),
    sec('Linear: open issues assigned to the owner (14 days) and issues touched in 3 days that name the owner', linearItems(vault, ownerName)),
    sec('Notion: pages edited in the last 3 days', notionItems(vault)),
    sec('Memories written or changed in the last 3 days, all workspaces', memoryItems(vault)),
    sec('Marked owed in memory', owed),
    sec('Data freshness (say so in the brief if a source is more than a day old)', freshness(vault)),
  ].join('\n\n');
  if (packet.length > PACKET_BYTES) packet = packet.slice(0, PACKET_BYTES) + '\n(packet truncated)';
  return packet;
}

const BRIEF_RULES = `You are writing the owner's morning brief from their second-brain vault (your working directory). Below is a packet of what came in across Slack, Linear and Notion, today's calendar, the owner's own recent working memories, and what memory says is owed. Decide where the owner should focus TODAY.
Use the packet first. Use Grep/Read on wiki/ only to add context (what the thread is about, what is already decided, a date that matters). Do not invent anything the packet and wiki do not state.
Write exactly these three sections and nothing else:
## Focus today
Up to 5 numbered items, most important first. Each: a bold one-line action, then one sentence of why (who is waiting, what date, what is blocked), then the source links.
## Waiting on you
People who asked the owner something and have no reply yet: who, where, what. Up to 8 bullets.
## Heads-up
Dates, go-lives, changes or risks in the next 7 days that the wiki or packet states. Up to 5 bullets.
Rules: every bullet ends with one or more [[wikilinks]] copied from the packet or from files you opened (wiki/..., slack/..., linear/issues/..., notion/pages/...). A bullet without a real link will be deleted. Plain sentences, no em dashes, no filler. Write about 80% to ASD-STE100 Simplified Technical English: short sentences (about 20 words for prose, 15 for steps), common words with one meaning each, the same term for the same thing every time, active voice, one instruction per sentence, one idea per paragraph, no hedging words, keep articles. Keep a natural tone. If a section has nothing real, write "Nothing." under it.`;

// Every [[link]] must resolve to a file; bullets that cite nothing real are dropped.
function checkCites(vault, text) {
  let dropped = 0;
  const keep = text.split('\n').filter((line) => {
    if (!/^\s*(?:-|\d+\.)\s/.test(line)) return true;
    const links = [...line.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1]);
    const ok = links.length && links.every((l) => fs.existsSync(path.join(vault, `${l}.md`)) || fs.existsSync(path.join(vault, l)));
    if (!ok) dropped++;
    return ok;
  });
  return { text: keep.join('\n'), dropped };
}

async function synthesize(ctx, packet) {
  const { claudeBin, vault, env, logLine, run } = ctx;
  const r = await claudeCall({ claudeBin, vault, env }, {
    prompt: `${BRIEF_RULES}\n\n${packet}`, model: 'sonnet',
    allowed: 'Read(./wiki/**),Glob,Grep', budget: SYNTH_BUDGET, timeoutMs: 10 * 60000,
  });
  const p = r.result;
  const cost = (p && p.total_cost_usd) || 0;
  if (!p) return { error: `claude exited ${r.code}`, cost };
  if (p.subtype === 'error_max_budget_usd') return { error: `hit the ${SYNTH_BUDGET} budget`, cost };
  const text = String(p.result || '');
  if (!/## Focus today/.test(text)) return { error: 'no Focus section in the answer', cost };
  logLine(run, `synthesis: ${cost.toFixed(2)}`);
  return { text, cost };
}

async function runBrief(run, ctx) {
  const { vault, logLine, finish } = ctx;
  const today = ctx.today || localDate(vault);
  const ownerEmail = (ctx.owner && ctx.owner.email) || '';
  let calFile = path.join(vault, 'gcal', `${today}.md`);
  let calNote = '';
  if (!fs.existsSync(calFile)) {
    const latest = fs.readdirSync(path.join(vault, 'gcal')).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().pop();
    calNote = latest ? `_No calendar file for today. The newest is ${latest.slice(0, 10)}${ctx.refreshed ? `; Sync Calendar just ran and ${ctx.refreshed.status === 'ok' ? 'wrote nothing for today' : `finished ${ctx.refreshed.status}`}` : '; run Sync Calendar'}._` : '_No calendar synced yet._';
    calFile = latest ? path.join(vault, 'gcal', latest) : '';
  }
  const events = calFile && !calNote ? parseEvents(read(calFile)) : [];
  logLine(run, `${events.length} event(s) on ${today}`);

  // A meeting's topic pages: the page whose own name or slug appears in the
  // title or description (partners/acme for "Int- Acme All Workstreams"). Own
  // terms only, so the dozens of acme-* pages don't dilute the match.
  const index = buildIndex(vault).filter((pg) => !pg.person);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const topicsOf = (e) => {
    const txt = `${e.title}\n${e.body.slice(0, 1500)}`.toLowerCase();
    const hit = index.filter((pg) => [...pg.terms].some(([t, tier]) => tier === 'own' && new RegExp(`(^|[^a-z0-9])${esc(t)}([^a-z0-9]|$)`).test(txt)));
    return hit.map((pg) => pg.rel).slice(0, 3);
  };
  const eventMd = events.map((e) => {
    const people = peopleFor(vault, e.attendees, ownerEmail);
    const pages = topicsOf(e);
    const links = [...new Set([...pages, ...people.slice(0, 4)])].map((p) => `[[${p.replace(/\.md$/, '')}]]`);
    const n = e.attendees.length;
    return `- **${e.time}** ${e.title}${n > 2 ? ` (${n} attending)` : ''}${links.length ? `\n  ${links.join(' · ')}` : ''}`;
  });

  const needs = parseNeedsYou(read(path.join(vault, 'Needs-You.md')));
  const open = [...needs.values()].filter((i) => i.section !== 'Resolved' && !i.boxes.some((b) => b.on));
  const nC = open.filter((i) => i.id.startsWith('c-')).length;
  const nG = open.filter((i) => i.id.startsWith('g-')).length;
  const { owed, open: nResume } = owedFromMemory(vault);

  // The ranked part: one model call over a packet that code assembled.
  let focus = null, synthCost = 0, dropped = 0, synthErr = '';
  if (ctx.claudeBin && !ctx.noSynth) {
    const packet = buildPacket(vault, ctx.ownerName || '', eventMd, owed);
    logLine(run, `packet ${Math.round(packet.length / 1024)}KB; asking sonnet where to focus…`);
    const r = await synthesize(ctx, packet);
    synthCost = r.cost || 0;
    if (r.error) synthErr = r.error; else { const c = checkCites(vault, r.text); focus = c.text.trim(); dropped = c.dropped; }
    logLine(run, synthErr ? `synthesis failed: ${synthErr}` : `synthesis kept; ${dropped} bullet(s) dropped for missing or dead links`);
  }

  const md = [
    '---', 'tags: [brief]', `date: ${today}`, '---', '',
    `# Brief — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`, '',
    ...(focus ? [focus, ''] : [synthErr ? `_Focus section unavailable: ${synthErr}_` : '_Focus section not generated (no model run)._', '']),
    '## Calendar today', '',
    ...(calNote ? [calNote] : eventMd.length ? eventMd : ['_Nothing on the calendar._']), '',
    '## Owed', '',
    ...(owed.length ? owed.map((o) => `- ${o}`) : ['_Nothing marked owed._']),
    ...(nResume ? ['', `_${nResume} RESUME threads open in total._`] : []), '',
    '## Needs you', '',
    nC + nG ? `${nC} contradiction(s) and ${nG} possible gap(s) in [[Needs-You]].` : '_Nothing waiting._', '',
    '## Bots', '', ...statusLines(vault, ctx), '', `_Data: ${freshness(vault).join(' · ')}_`, '',
  ].join('\n');

  fs.writeFileSync(path.join(vault, 'Brief.md'), md);
  const cost = ((ctx.refreshed && ctx.refreshed.costUsd) || 0) + synthCost;
  finish(run, calNote || synthErr || (ctx.refreshed && ctx.refreshed.status === 'error') ? 'warn' : 'ok',
    `${events.length} meeting(s) · ${focus ? `${(focus.match(/^\d+\./gm) || []).length} focus item(s)` : 'no focus section'} · ${nC + nG} need you`,
    { markdown: md, file: 'Brief.md', calendarRefresh: ctx.refreshed || null }, cost);
}

module.exports = { runBrief, parseEvents, owedFromMemory, buildPacket, checkCites };
