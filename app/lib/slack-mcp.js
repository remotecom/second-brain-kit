// Slack sync through the claude.ai Slack connector, with the model reduced to
// a button-presser. The runner decides every query and every thread; the
// model only calls the two tools; plain code renders the day files from the
// raw tool results it sees in the event stream.
//
// Why (2026-10-01): five runs that had the model WRITE the day files cost ~$22
// and none passed the gate. Re-typing ~70 messages a day as output tokens was
// the cost, and the model kept substituting summaries for replies. Here the
// model writes nothing, so it can't do either. No Slack token needed.
//
//   phase 1  runner: exact search args ─▶ model calls search + follows cursors
//            runner: parse results; any query whose last page still has a
//                    cursor gets a continuation run from that cursor
//   phase 2  runner: thread list (Reply count > 0 or thread_ts in permalink)
//            model calls read_thread on each, in batches
//            runner: every listed thread must come back, or HOLD
//   render   runner: day files (the owner's days, owner.timezone; Slack's
//            formatted times are in the Slack profile's zone, keep them equal)
//            ─▶ sync.verify ─▶ sync.commit ─▶ watermark

const fs = require('fs');
const path = require('path');
const { verify, commit, rangeFor } = require('./sync');
const { redact } = require('./redact');
const { pressButtons } = require('./buttons');
const { requireOwner, getConfig } = require('./config');
const { dayOf, dayStart } = require('./time');
const { readPending, writePending } = require('./ledger');
const { tool, connectorError } = require('./connectors');

const PLACEHOLDER = '_Earlier replies not synced (mention-only thread)._';
const MENTION_TAIL = 5;
const THREAD_BATCH = 30;
const DAY = 86400000;

function parseJSONText(text) {
  try { return JSON.parse(text); } catch { return null; }
}
const nextCursor = (pag) => { const m = String(pag || '').match(/cursor `([^`]+)`/); return m ? m[1] : null; };

// --- parsing the connector's text format -------------------------------------

function parseSearch(resultsText) {
  const out = [];
  for (const block of String(resultsText || '').split(/\n### Result \d+ of \d+\n/).slice(1)) {
    const g = (re) => { const m = block.match(re); return m ? m[1].trim() : ''; };
    const chan = block.match(/^Channel: (.*?) \(ID: ([A-Z0-9]+)\)/m);
    const from = block.match(/^From: (.*?) (?:<[^>]*> )?\(ID: ([A-Z0-9]+)\)/m);
    const text = (block.split(/\nText: ?\n/)[1] || '').split(/\nContext before:|\n---\s*$/)[0].replace(/\n---\s*\n?$/, '').trim();
    const permalink = (block.match(/^Permalink: \[link\]\((.*?)\)/m) || [])[1] || '';
    const ts = g(/^Message_ts: (\S+)/m);
    out.push({
      channelLabel: chan ? chan[1] : '', channelId: chan ? chan[2] : '',
      participants: g(/^Participants: (.*)$/m),
      author: from ? from[1] : '', authorId: from ? from[2] : '',
      time: g(/^Time: (.*)$/m), ts, replyCount: Number(g(/^Reply count: (\d+)/m) || 0),
      permalink, threadTs: (permalink.match(/[?&]thread_ts=([\d.]+)/) || [])[1] || null, text,
    });
  }
  return out;
}

function parseThread(messagesText) {
  const msgs = [];
  const blocks = String(messagesText || '').split(/\n?=== THREAD PARENT MESSAGE ===\n|\n--- Reply \d+ of \d+ ---\n|\n=== THREAD REPLIES \(\d+ total\) ===\n/).filter((b) => b.trim());
  for (const b of blocks) {
    const from = b.match(/^From: (.*?) (?:<[^>]*> )?\(([A-Z0-9]+)\)/m);
    const time = (b.match(/^Time: (.*)$/m) || [])[1] || '';
    const ts = (b.match(/^Message TS: (\S+)/m) || [])[1] || '';
    if (!ts) continue;
    const body = b.split(/^Message TS: \S+\n?/m)[1] || '';
    const lines = body.split('\n').filter((l) => !/^Reactions: /.test(l));
    msgs.push({ author: from ? from[1] : '', authorId: from ? from[2] : '', time, ts, text: lines.join('\n').trim() });
  }
  return msgs;
}

// "2026-09-25 04:25:16 PDT" -> { day: "2026-09-25", clock: "4:25 AM" }
function whenOf(time) {
  const m = String(time).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
  if (!m) return { day: '', clock: time };
  const h = Number(m[2]), ap = h >= 12 ? 'PM' : 'AM';
  return { day: m[1], clock: `${h % 12 || 12}:${m[3]} ${ap}` };
}

function cleanText(t, onSecret) {
  const s = String(t || '')
    .replace(/<@[UW][A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!subteam\^[A-Z0-9]+\|?([^>]*)>/g, (m, n) => n || '@group')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1');
  return redact(s, onSecret).split('\n').join('\n  ');
}

// Unix seconds of local midnight that starts a YYYY-MM-DD in tz.
const midnight = (day, tz) => Math.floor(dayStart(day, tz) / 1000);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// --- the bot ------------------------------------------------------------------

async function syncSlackMcp(run, ctx) {
  const { vault, logLine, finish, src } = ctx;
  const log = (s) => logLine(run, s);
  const SEARCH = tool(vault, 'slack', 'slack_search_public_and_private');
  const THREAD = tool(vault, 'slack', 'slack_read_thread');
  // The owner's days throughout: the day files use them, and using UTC
  // "today" ran the range a day into the future in the evening (2026-10-01).
  const cfg = getConfig(vault), tz = cfg.owner.timezone;
  const localToday = dayOf(new Date(), tz);
  const r0 = rangeFor(vault, { ...src, windowDays: cfg.sources.slack.window_days }, Date.parse(`${localToday}T12:00:00Z`));
  // The range is the rolling window plus any day still holding a thread an
  // earlier run could not read (.bot/state/slack-pending.json). Not the
  // watermark: one unread thread used to hold it, and every later run then
  // re-walked from that day (09-21 → 10-02, measured 2026-10-02).
  const pendingDays = readPending(vault, 'slack').filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const since = Math.min(r0.windowStart, ...pendingDays.map((d) => Date.parse(`${d}T00:00:00Z`)));
  const range = { ...r0, since, today: Date.parse(`${localToday}T00:00:00Z`) };
  if (pendingDays.length) log(`re-walking ${pendingDays.length} day(s) with threads left unread last time: ${pendingDays.join(', ')}`);
  const days = [];
  for (let d = range.since; d <= range.today; d += DAY) days.push(isoDay(d));
  let owner;
  try { owner = requireOwner(vault, ['slack_user_id', 'name']); } catch (e) { return finish(run, 'error', e.message); }
  const me = owner.slack_user_id;
  log(`range ${days[0]} → ${days[days.length - 1]} (${tz} days) · haiku presses buttons, runner writes`);
  let cost = 0;

  // Phase 1: searches, run to exhaustion. Unix after/before is exact, which
  // avoids the before:-drops-a-day trap of the date filter.
  // One query per kind PER DAY: Slack search stops at 20 pages x 20 = 400
  // results (measured 2026-10-01: a 12-day sent search capped at exactly 400).
  const hits = { sent: new Map(), mentions: new Map() };
  const pending = [];
  for (const day of days) {
    const base = { after: String(midnight(day, tz)), before: String(midnight(isoDay(Date.parse(`${day}T00:00:00Z`) + DAY), tz) - 1), include_context: false, limit: 20, sort: 'timestamp', sort_dir: 'asc', response_format: 'detailed', channel_types: 'public_channel,private_channel,mpim,im', natural_language_query: '' };
    pending.push({ kind: 'sent', day, args: { ...base, filters: `from:<@${me}>` }, cursor: null });
    pending.push({ kind: 'mentions', day, args: { ...base, query: `<@${me}> -from:<@${me}>` }, cursor: null });
  }
  const SEARCH_BATCH = 8;
  for (let round = 1; pending.length && round <= 5; round++) {
    const still = [];
    for (let i = 0; i < pending.length; i += SEARCH_BATCH) {
      const batch = pending.slice(i, i + SEARCH_BATCH);
      const instr = [
        `Call the tool ${SEARCH} with EXACTLY these argument objects, one call each (load it with ToolSearch "select:${SEARCH}" first):`,
        ...batch.map((p) => `  ${JSON.stringify({ ...p.args, ...(p.cursor ? { cursor: p.cursor } : {}) })}`),
        'After each result, if its pagination_info gives a cursor, call the tool again with the SAME arguments plus that cursor. Keep going until pagination_info gives no cursor. Run independent calls in parallel in one message.',
        'Do not read, summarize or judge the results. When every search is exhausted, reply with the single word DONE.',
      ].join('\n');
      const r = await pressButtons(ctx, run, instr, 2, [SEARCH, THREAD]);
      if (r.connector && !r.calls.length) throw Object.assign(connectorError('slack', `${r.connector.server}: ${r.connector.problem}`), { cost: cost + r.cost });
      cost += r.cost;
      for (const p of batch) {
        const key = p.args.filters || p.args.query;
        const pages = r.calls.filter((c) => c.name === SEARCH && String(c.input.after) === p.args.after && (c.input.filters === key || c.input.query === key));
        let last = null;
        for (const c of pages) {
          const j = parseJSONText(c.text);
          if (!j) continue;
          for (const h of parseSearch(j.results)) hits[p.kind].set(h.ts + h.channelId, h);
          last = j;
        }
        // No parseable page = not run (or errored): retry from where it was.
        if (!last) { still.push(p); continue; }
        const cur = nextCursor(last.pagination_info);
        if (cur) still.push({ ...p, cursor: cur });
      }
    }
    log(`search round ${round}: sent ${hits.sent.size}, mentions ${hits.mentions.size}${still.length ? ` · ${still.length} of ${days.length * 2} day-queries not finished, continuing` : ' · all exhausted'}`);
    pending.splice(0, pending.length, ...still);
  }
  if (pending.length) return finish(run, 'error', `searches never reached their last page after 5 rounds; nothing written`, null, cost);

  // Phase 2: threads, exact list decided here.
  const want = new Map(); // key -> {channelId, ts}
  for (const kind of ['sent', 'mentions']) {
    for (const h of hits[kind].values()) {
      const tts = h.threadTs || (h.replyCount > 0 ? h.ts : null);
      if (tts && h.channelId) want.set(`${h.channelId}:${tts}`, { channelId: h.channelId, ts: tts });
    }
  }
  const threads = new Map(); // key -> messages[]
  for (let round = 1; round <= 3; round++) {
    const todo = [...want].filter(([k]) => !threads.has(k)).map(([, v]) => v);
    if (!todo.length) break;
    for (let i = 0; i < todo.length; i += THREAD_BATCH) {
      const batch = todo.slice(i, i + THREAD_BATCH);
      const instr = [
        `Call the tool ${THREAD} once for EACH of these, with exactly these arguments (load it with ToolSearch "select:${THREAD}" first):`,
        ...batch.map((t) => `  ${JSON.stringify({ channel_id: t.channelId, message_ts: t.ts, limit: 1000 })}`),
        'If a result says there are more messages and gives a cursor, call again with that cursor. Run many calls in parallel per message.',
        'Do not read, summarize or judge the results. When all are done, reply with the single word DONE.',
      ].join('\n');
      const r = await pressButtons(ctx, run, instr, 2, [SEARCH, THREAD]);
      if (r.connector && !r.calls.length) throw Object.assign(connectorError('slack', `${r.connector.server}: ${r.connector.problem}`), { cost: cost + r.cost });
      cost += r.cost;
      for (const c of r.calls.filter((x) => x.name === THREAD)) {
        const j = parseJSONText(c.text);
        if (!j || !j.messages) continue;
        const key = `${c.input.channel_id}:${c.input.message_ts}`;
        const msgs = parseThread(j.messages);
        if (msgs.length) threads.set(key, [...(threads.get(key) || []), ...msgs]);
      }
    }
    log(`thread round ${round}: ${threads.size}/${want.size} read`);
  }
  const unread = [...want.keys()].filter((k) => !threads.has(k));

  // Render.
  let secrets = 0;
  const onSecret = () => { secrets++; };
  const byDay = new Map(days.map((d) => [d, { sent: [], mentions: [] }]));
  const placed = { sent: new Set(), mentions: new Set() };
  const label = (h) => (h.channelLabel === 'DM' || /^DM/.test(h.channelLabel)
    ? `DM with ${(h.participants.split(',').map((s) => s.replace(/\s*\(ID:.*?\)/, '').trim()).find((n) => n !== owner.name)) || 'someone'}`
    : h.channelLabel);

  for (const kind of ['sent', 'mentions']) {
    for (const h of [...hits[kind].values()].sort((a, b) => Number(a.ts) - Number(b.ts))) {
      const tts = h.threadTs || (h.replyCount > 0 ? h.ts : null);
      const key = tts ? `${h.channelId}:${tts}` : `${h.channelId}:${h.ts}:single`;
      if (placed[kind].has(key)) continue;
      placed[kind].add(key);
      const thread = tts ? threads.get(`${h.channelId}:${tts}`) : null;
      const root = thread ? thread[0] : h;
      const w = whenOf(root.time), wh = whenOf(h.time);
      const day = byDay.has(w.day) ? w.day : wh.day;
      if (!byDay.has(day)) continue;
      const lines = [`- **${w.clock}** · ${label(h)} [↗](${h.permalink.replace(/[?&]thread_ts=.*$/, '') || h.permalink})`];
      lines.push(root.authorId === me && kind === 'sent' ? `  ${cleanText(root.text, onSecret)}` : `  **${root.author}**: ${cleanText(root.text, onSecret)}`);
      if (thread && thread.length > 1) {
        const replies = thread.slice(1);
        const ownerPosted = thread.some((m) => m.authorId === me);
        let shown = replies;
        if (!ownerPosted) {
          const keep = new Set(replies.slice(-MENTION_TAIL).map((m) => m.ts));
          for (const m of replies) if (m.text.includes(`<@${me}`) || m.text.includes(`@${owner.name}`)) keep.add(m.ts);
          shown = replies.filter((m) => keep.has(m.ts));
        }
        let last = -1;
        for (const m of shown) {
          const idx = replies.indexOf(m);
          if (!ownerPosted && idx > last + 1) lines.push(`    ${PLACEHOLDER}`);
          lines.push(`    - **${m.author}** · ${whenOf(m.time).clock}: ${cleanText(m.text, onSecret).split('\n').join('\n    ')}`);
          last = idx;
        }
      }
      byDay.get(day)[kind].push({ ts: Number(root.ts) || Number(h.ts), text: lines.join('\n') });
    }
  }

  // Chronological within each section, by thread root time.
  const ordered = (list) => list.sort((a, b) => a.ts - b.ts).map((e) => e.text).join('\n\n');
  const files = new Map();
  for (const [day, d] of byDay) {
    const title = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${day}T12:00:00Z`));
    files.set(`slack/${day}.md`, ['---', `date: ${day}`, 'tags: [slack, daily-sync]', '---', '', `# Slack — ${title}`, '',
      '## Sent Messages', '', d.sent.length ? ordered(d.sent) : '_No messages._', '',
      '## Mentions & Tags', '', d.mentions.length ? ordered(d.mentions) : '_No messages._', ''].join('\n'));
  }
  log(`rendered ${files.size} day file(s): ${hits.sent.size} sent, ${hits.mentions.size} mentions, ${threads.size} threads${secrets ? `, ${secrets} credential(s) redacted` : ''}`);

  const { problems, notes } = verify(vault, src, { emitted: [...files.keys()] }, files, range, { modelAuthored: false });
  for (const n of notes) log(`note: ${n}`);
  for (const p of problems) log(`GATE: ${p}`);
  if (problems.length) return finish(run, 'error', `gate failed (${problems.length}); nothing written`, { problems }, cost);

  const { written, skipped } = commit(vault, files);
  let moved = 'unchanged';
  const maxTs = Math.max(0, ...[...hits.sent.values(), ...hits.mentions.values()].map((h) => Number(h.ts)));
  // Unread threads go on the ledger as the local day of their root, so the
  // next run re-walks just those days; the watermark (advisory) moves on.
  const dayOfTs = (ts) => dayOf(new Date(Number(ts) * 1000), tz);
  const unreadDays = [...new Set(unread.map((k) => dayOfTs(k.split(':')[1])))].sort();
  writePending(vault, 'slack', unreadDays);
  for (const k of unread.slice(0, 10)) log(`gap: thread not read: ${k} (its day goes on the pending list)`);
  if (maxTs && (!range.watermark || maxTs * 1000 > range.watermark)) {
    fs.writeFileSync(path.join(vault, 'slack', '.last-sync'), `${new Date(maxTs * 1000).toISOString().replace(/\.\d+Z$/, 'Z')}\n`);
    moved = `→ ${new Date(maxTs * 1000).toISOString().slice(0, 16)}Z`;
  }
  finish(run, unread.length ? 'warn' : 'ok',
    `${written} written, ${skipped} unchanged · ${hits.sent.size} sent, ${hits.mentions.size} mentions, ${threads.size}/${want.size} threads · watermark ${moved}${unreadDays.length ? ` · ${unread.length} thread(s) pending (${unreadDays.join(', ')})` : ''}`,
    { sent: hits.sent.size, mentions: hits.mentions.size, threads: threads.size, unread: unread.length, secrets }, cost);
}

module.exports = { syncSlackMcp, parseSearch, parseThread, whenOf, midnight };
