// Google Calendar sync, "model presses buttons, code writes" (like Slack,
// Linear and Notion). Replaces the model-written sync, which measured two
// problems on 2026-10-02: event times written in UTC but labelled as local
// (a 7:00 AM PT meeting showed as 2:00 PM), and runs blocked asking for Bash to
// measure description lengths.
//
//   range = the rolling window (sources.gcal.window_days, owner's days),
//           bootstrap_days on the first run
//     ▼
//   haiku: list_events(calendar, range, DEFAULT only), every page ─▶ raw JSON
//     ▼
//   code: drop private + declined (counted), group by local start day,
//         render every day in range (quiet days get the declared placeholder)
//     ▼
//   sync.verify ─▶ sync.commit (hash skip) ─▶ watermark (max `updated`, advisory)
//
// The calendar allowlist is config (sources.gcal.calendars), never "every
// calendar the account can read": that list includes a personal Gmail calendar
// and a colleague's calendar (CLAUDE.md, Sync (Google Calendar) step 4).

const fs = require('fs');
const path = require('path');
const { verify, commit } = require('./sync');
const { collect } = require('./buttons');
const { getConfig } = require('./config');
const { dayOf, timeOf, dayStart, offsetAt } = require('./time');
const { tool } = require('./connectors');

const DAY = 864e5;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
// The owner's UTC offset at local midnight of `day`, as "-07:00", for the
// call's time bounds.
const offsetOn = (day, tz) => offsetAt(dayStart(day, tz), tz);

function driveId(url) {
  const m = String(url || '').match(/\/d\/([\w-]{10,})/) || String(url || '').match(/[?&]id=([\w-]{10,})/);
  return m ? m[1] : null;
}

// o = { tz, maxDesc }: the owner's zone and the declared description cap.
function renderEvent(e, calendar, o) {
  const start = e.start || {}, end = e.end || {};
  const when = start.dateTime
    ? `${timeOf(new Date(start.dateTime), o.tz)}–${timeOf(new Date(end.dateTime || start.dateTime), o.tz)}`
    : 'All day';
  const lines = [`## ${when} · ${e.summary || '(no title)'}`];
  const org = e.organizer || {};
  if (org.email || org.displayName) lines.push(`- **Organizer:** ${org.displayName ? `${org.displayName} (${org.email || ''})` : org.email}`);
  const att = (e.attendees || []).filter((a) => !a.resource);
  if (att.length) lines.push(`- **Attendees:** ${att.map((a) => `${a.email || a.displayName} (${a.responseStatus || 'unknown'})`).join(', ')}`);
  const loc = e.location || e.conferenceUrl || (e.hangoutLink || '');
  if (loc) lines.push(`- **Location:** ${loc}`);
  lines.push(`- **Calendar:** ${calendar}`);
  if ((e.attachments || []).length) {
    lines.push(`- **Attachments:** ${e.attachments.map((a) => { const id = driveId(a.fileUrl); return id ? `[[gdrive/files/${id}]] — ${a.title || ''}` : `${a.title || ''} (${a.fileUrl || ''})`; }).join('; ')}`);
  }
  let truncated = false;
  let desc = String(e.description || '').trim();
  if (desc.length > o.maxDesc) { desc = `${desc.slice(0, o.maxDesc)}\n\n[truncated at ${o.maxDesc} chars — full text in the source event]`; truncated = true; }
  if (desc) lines.push('', desc);
  return { md: lines.join('\n'), truncated };
}

function renderDay(day, calendars, evs, excluded, o) {
  const d = new Date(`${day}T12:00:00Z`);
  const title = d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const rendered = evs.map((x) => renderEvent(x.e, x.calendar, o));
  const truncated = rendered.some((r) => r.truncated);
  return [
    '---', `date: ${day}`, 'tags: [gcal, daily-sync]', `calendars: [${calendars.join(', ')}]`,
    `event_count: ${evs.length}`, `excluded: { private: ${excluded.private}, declined: ${excluded.declined} }`, `truncated: ${truncated}`, '---', '',
    `# Calendar — ${title}`, '',
    ...(rendered.length ? rendered.flatMap((r) => [r.md, '']) : ['_No events on the synced calendar this day._', '']),
  ].join('\n');
}

async function syncGcalMcp(run, ctx) {
  const { vault, logLine, finish, src } = ctx;
  const log = (s) => logLine(run, s);
  const TOOL = tool(vault, 'gcal', 'list_events');
  const cfg = getConfig(vault);
  const g = cfg.sources.gcal, tz = cfg.owner.timezone;
  const o = { tz, maxDesc: g.max_description_chars };
  const calendars = g.calendars.map(String);
  if (!calendars.length) return finish(run, 'error', 'set sources.gcal.calendars in config.yaml (the allowlist of calendars to sync)');

  const today = dayOf(new Date(), tz);
  let wm = null; try { wm = Date.parse(fs.readFileSync(path.join(vault, 'gcal', '.last-sync'), 'utf8').trim()); } catch {}
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  // An explicit re-sync ("sync gcal since DATE") widens the window; it never narrows it.
  const since = /^\d{4}-\d{2}-\d{2}$/.test((ctx.body || {}).since || '') ? Date.parse(`${ctx.body.since}T00:00:00Z`) : null;
  let back = Number.isFinite(wm) ? g.window_days - 1 : cfg.bootstrap_days - 1;
  if (since !== null && since < todayMs) back = Math.max(back, Math.round((todayMs - since) / DAY));
  const days = [];
  for (let t = todayMs - back * DAY; t <= todayMs; t += DAY) days.push(isoDay(t));
  const range = { since: Date.parse(`${days[0]}T00:00:00Z`), today: todayMs, watermark: Number.isFinite(wm) ? wm : null };
  log(`range ${days[0]} → ${today} (${tz} days)${since !== null ? ' · explicit re-sync' : Number.isFinite(wm) ? '' : ` · first run, ${cfg.bootstrap_days}-day bootstrap`} · calendars: ${calendars.join(', ')}`);

  const tomorrow = isoDay(todayMs + DAY);
  const jobs = calendars.map((c) => ({ args: {
    calendarId: c, startTime: `${days[0]}T00:00:00${offsetOn(days[0], tz)}`, endTime: `${tomorrow}T00:00:00${offsetOn(tomorrow, tz)}`,
    eventType: ['DEFAULT'], orderBy: 'startTime', pageSize: 250,
  } }));
  const res = await collect(ctx, run, TOOL, jobs, {
    pageOf: (j) => (Array.isArray(j.events) ? { items: j.events, next: j.nextPageToken || null } : null),
    cursorKey: 'pageToken', batch: 5, budget: 1, label: 'list_events',
  });
  if (res.unfinished.length) return finish(run, 'error', `list_events never finished for ${res.unfinished.length} calendar(s); nothing written, watermark NOT moved`, { unfinished: res.unfinished }, res.cost);

  const byDay = new Map(days.map((d) => [d, []]));
  const excluded = new Map(days.map((d) => [d, { private: 0, declined: 0 }]));
  let maxUpdated = 0, kept = 0, seen = new Set();
  for (const job of jobs) {
    for (const e of res.results.get(res.keyOf(job.args)) || []) {
      if (!e || seen.has(e.id) || e.status === 'cancelled') continue;
      seen.add(e.id);
      const day = e.start && e.start.dateTime ? dayOf(new Date(e.start.dateTime), tz) : (e.start && e.start.date) || null;
      if (!day || !byDay.has(day)) continue;
      const u = Date.parse(e.updated || ''); if (u > maxUpdated) maxUpdated = u;
      const self = (e.attendees || []).find((a) => a.self);
      if (e.visibility === 'private') { excluded.get(day).private++; continue; }
      if (self && self.responseStatus === 'declined') { excluded.get(day).declined++; continue; }
      byDay.get(day).push({ e, calendar: job.args.calendarId });
      kept++;
    }
  }
  const files = new Map();
  for (const d of days) files.set(`gcal/${d}.md`, renderDay(d, calendars, byDay.get(d), excluded.get(d), o));
  const ex = [...excluded.values()].reduce((a, x) => ({ private: a.private + x.private, declined: a.declined + x.declined }), { private: 0, declined: 0 });
  log(`${seen.size} event(s) listed · ${kept} kept · excluded ${ex.private} private, ${ex.declined} declined`);

  const { problems, notes } = verify(vault, src, { emitted: [...files.keys()] }, files, range, { modelAuthored: false });
  for (const n of notes) log(`note: ${n}`);
  for (const p of problems) log(`GATE: ${p}`);
  if (problems.length) return finish(run, 'error', `gate failed (${problems.length}); nothing written`, { problems }, res.cost);
  const { written, skipped } = commit(vault, files);
  let moved = 'unchanged';
  if (maxUpdated && (!range.watermark || maxUpdated > range.watermark)) {
    fs.writeFileSync(path.join(vault, 'gcal', '.last-sync'), `${new Date(maxUpdated).toISOString().replace(/\.\d+Z$/, 'Z')}\n`);
    moved = `→ ${new Date(maxUpdated).toISOString().slice(0, 16)}Z`;
  }
  finish(run, 'ok', `${written} written, ${skipped} unchanged · ${kept} events over ${days.length} days · excluded ${ex.private} private, ${ex.declined} declined · watermark ${moved}`,
    { events: kept, excluded: ex, days: days.length }, res.cost);
}

module.exports = { syncGcalMcp, renderDay, renderEvent, offsetOn };
