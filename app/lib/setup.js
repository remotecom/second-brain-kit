// The Setup page's backend (T14). Seven steps:
//   connectors -> identity -> scope -> privacy -> schedule -> obsidian -> first run
//
// Probes press connector buttons (haiku) and CODE reads the results; nothing
// the model says is taken as a fact. Saves write config.yaml as text
// (config.writeValues), so the owner's comments survive. State lives in
// .bot/state/setup.json: the last probe results and which steps are done.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pressButtons, collect } = require('./buttons');
const { getConfig, readOwner, writeValues } = require('./config');
const { tool, HEALTH_CALLS, REQUIRED, judgeResult, NAMES } = require('./connectors');

const STEPS = ['connectors', 'identity', 'scope', 'privacy', 'schedule', 'obsidian', 'first-run', 'wiki-shape'];
const SOURCES = Object.keys(REQUIRED);

const stateFile = (vault) => path.join(vault, '.bot', 'state', 'setup.json');
function readState(vault) { try { return JSON.parse(fs.readFileSync(stateFile(vault), 'utf8')); } catch { return { probes: {}, done: {} }; } }
function writeState(vault, patch) {
  const next = { ...readState(vault), ...patch };
  fs.mkdirSync(path.dirname(stateFile(vault)), { recursive: true });
  fs.writeFileSync(stateFile(vault), JSON.stringify(next, null, 2));
  return next;
}
function markDone(vault, step) { const st = readState(vault); st.done = { ...st.done, [step]: new Date().toISOString() }; return writeState(vault, { done: st.done }); }
const parse = (c) => { try { return JSON.parse(c.text); } catch { return null; } };

// --- 1. connectors (decision 3A) ---------------------------------------------------
// Find every prefix that has each source's required tool, then make one cheap
// call per candidate. One working candidate is chosen; several = the owner picks.
async function probeConnectors(ctx, run) {
  const { vault } = ctx;
  const s1 = await pressButtons(ctx, run, [
    'Use ToolSearch once for EACH of these queries, max_results 10, exactly as written. If an answer says some MCP servers are still connecting, run that same query again (up to 3 times in all). Call nothing else. Then reply DONE.',
    ...SOURCES.map((k) => `  ${REQUIRED[k]}`),
  ].join('\n'), 0.3, []);
  const names = new Set();
  let connecting = '';
  for (const t of s1.searches) {
    for (const m of t.matchAll(/mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_-]+/g)) names.add(m[0]);
    const c = /still connecting: (.*?)\.(?: Their|\s*$)/.exec(t);
    if (c) connecting += ` ${c[1]}`;
  }
  const cands = {};
  for (const k of SOURCES) cands[k] = [...names].filter((n) => n.endsWith(`__${REQUIRED[k]}`)).map((n) => n.slice(0, -(REQUIRED[k].length + 2)));
  const owner = readOwner(vault);
  const calls = SOURCES.flatMap((k) => cands[k].map((p) => ({ k, p, t: `${p}__${HEALTH_CALLS[k][0]}`, args: HEALTH_CALLS[k][1](owner) })));
  let s2 = { calls: [], cost: 0 };
  if (calls.length) {
    s2 = await pressButtons(ctx, run, ['Call each tool below exactly once with exactly these arguments (load each with ToolSearch "select:<tool>" first). Call nothing else. Do not repeat any result. Then reply DONE.',
      ...calls.map((c) => `  ${c.t} ${JSON.stringify(c.args)}`)].join('\n'), 0.5, calls.map((c) => c.t));
  }
  const current = getConfig(vault).connectors;
  const out = {};
  for (const k of SOURCES) {
    const list = cands[k].map((p) => { const j = judgeResult(s2.calls.find((x) => x.name === `${p}__${HEALTH_CALLS[k][0]}`)); return { prefix: p, status: j.status === 'none' ? 'error' : j.status, why: j.why || '' }; });
    const ok = list.filter((x) => x.status === 'ok');
    const chosen = ok.length === 1 ? ok[0].prefix : ok.find((x) => x.prefix === current[k]) ? current[k] : null;
    // No candidate while its server was still connecting: say so, not "not connected".
    const slow = !list.length && connecting.includes(`claude.ai ${NAMES[k]}`);
    out[k] = { name: NAMES[k], candidates: list, chosen, ambiguous: ok.length > 1 && !chosen, connecting: slow };
  }
  const probes = { ...readState(vault).probes, connectors: { at: new Date().toISOString(), sources: out } };
  writeState(vault, { probes });
  return { result: out, cost: s1.cost + s2.cost };
}

// --- 2. identity --------------------------------------------------------------------
async function probeIdentity(ctx, run) {
  const { vault } = ctx;
  const o = readOwner(vault);
  const auth = require('./install').claudeAuth(ctx.claudeBin) || {};
  const email = o.email && !/@example\.com$/.test(o.email) ? o.email : auth.email || '';
  const name = o.name && o.name !== 'Your Name' ? o.name : '';
  const calls = [];
  if (email) calls.push({ k: 'slack', t: tool(vault, 'slack', 'slack_search_users'), args: { query: email, limit: 5 } });
  // Notion: by name and by the email's local part (either can be what Notion shows).
  const nq = [...new Set([name, email && email.split('@')[0]].filter(Boolean))];
  nq.forEach((q, i) => calls.push({ k: `notion${i}`, t: tool(vault, 'notion', 'notion-get-users'), args: { query: q, page_size: 10 } }));
  const r = calls.length ? await pressButtons(ctx, run, ['Call each tool below exactly once with exactly these arguments (load each with ToolSearch "select:<tool>" first). Call nothing else. Then reply DONE.',
    ...calls.map((c) => `  ${c.t} ${JSON.stringify(c.args)}`)].join('\n'), 0.3, calls.map((c) => c.t)) : { calls: [], cost: 0 };
  const res = { name, email, timezone: getConfig(vault).owner.timezone, slack: [], notion: [] };
  const sl = r.calls.find((c) => c.name === (calls.find((x) => x.k === 'slack') || {}).t);
  if (sl) {
    // Slack's search answers with text; take member IDs that appear with the email.
    const text = String(sl.text || '');
    for (const m of text.matchAll(/\b(U[A-Z0-9]{8,12})\b/g)) if (!res.slack.includes(m[1])) res.slack.push(m[1]);
  }
  const seen = new Set();
  for (const nl of r.calls.filter((c) => c.name === tool(vault, 'notion', 'notion-get-users'))) {
    const nj = parse(nl);
    for (const u of (nj && Array.isArray(nj.results) ? nj.results : [])) if (u.type !== 'bot' && !seen.has(u.id)) { seen.add(u.id); res.notion.push({ id: u.id, name: u.name, email: u.email || '' }); }
  }
  const best = res.notion.find((u) => email && u.email === email);
  res.notionId = best ? best.id : res.notion.length === 1 ? res.notion[0].id : '';
  res.slackId = res.slack.length === 1 ? res.slack[0] : '';
  writeState(vault, { probes: { ...readState(vault).probes, identity: { at: new Date().toISOString(), ...res } } });
  return { result: res, cost: r.cost };
}

// --- 3. scope: live, searchable Linear initiatives and teams ------------------------------
async function probeScope(ctx, run) {
  const { vault } = ctx;
  const page = (key) => (j) => (Array.isArray(j[key]) ? { items: j[key], next: j.hasNextPage ? j.cursor : null } : null);
  const ini = await collect(ctx, run, tool(vault, 'linear', 'list_initiatives'), [{ args: { limit: 100, fields: ['id', 'uuid', 'name', 'status'] } }], { pageOf: page('initiatives'), label: 'initiatives', maxRounds: 6 });
  const tms = await collect(ctx, run, tool(vault, 'linear', 'list_teams'), [{ args: { limit: 100 } }], { pageOf: page('teams'), label: 'teams', maxRounds: 4 });
  const res = {
    initiatives: [...ini.results.values()].flat().map((i) => ({ id: i.uuid || i.id, short: i.id, name: i.name, status: i.status || '' })),
    teams: [...tms.results.values()].flat().map((t) => ({ key: t.key, name: t.name || t.displayName || t.key })),
    complete: !ini.unfinished.length && !tms.unfinished.length,
  };
  writeState(vault, { probes: { ...readState(vault).probes, scope: { at: new Date().toISOString(), ...res } } });
  return { result: res, cost: ini.cost + tms.cost };
}

// --- 4. privacy preview (OV6) ----------------------------------------------------------
// Every calendar the account can read, and every top-level Drive folder.
// Defaults: the owner's own calendar only; every folder in; the Meet trees out.
async function probePrivacy(ctx, run) {
  const { vault } = ctx;
  const cfg = getConfig(vault);
  const cal = await collect(ctx, run, tool(vault, 'gcal', 'list_calendars'), [{ args: { pageSize: 250 } }], { pageOf: (j) => (Array.isArray(j.calendars) ? { items: j.calendars, next: null } : null), label: 'calendars', maxRounds: 2 });
  const q = "parentId = 'root' and mimeType = 'application/vnd.google-apps.folder'";
  const drv = await collect(ctx, run, tool(vault, 'gdrive', 'search_files'), [{ args: { query: q, pageSize: 100 } }], { pageOf: (j) => (Array.isArray(j.files) ? { items: j.files, next: j.nextPageToken || null } : null), cursorKey: 'pageToken', label: 'drive folders', maxRounds: 4 });
  const synced = new Set(cfg.sources.gcal.calendars.map(String));
  const excluded = new Set(cfg.sources.gdrive.exclude_folders.map(String));
  const titlesOut = new Set(cfg.sources.gdrive.exclude_folder_titles.map(String));
  const res = {
    calendars: [...cal.results.values()].flat().map((c) => ({ id: c.id, name: c.summary || c.id, on: synced.size ? synced.has(c.id) : c.id === cfg.owner.email })),
    folders: [...drv.results.values()].flat().map((f) => ({ id: f.id, name: f.name || f.title || f.id, on: !excluded.has(f.id) && !titlesOut.has(f.name || f.title), locked: titlesOut.has(f.name || f.title) })),
    // A list that never came back is not an empty list: say so, never "none".
    missing: [cal.unfinished.length && 'calendars', drv.unfinished.length && 'drive folders'].filter(Boolean),
  };
  writeState(vault, { probes: { ...readState(vault).probes, privacy: { at: new Date().toISOString(), ...res } } });
  return { result: res, cost: cal.cost + drv.cost };
}

// --- saves ------------------------------------------------------------------------------
function save(vault, step, v = {}) {
  const set = {};
  if (step === 'connectors') {
    for (const k of SOURCES) {
      if (v[k] && v[k].prefix) { if (!/^mcp__[A-Za-z0-9_-]+$/.test(v[k].prefix)) throw new Error(`bad prefix for ${k}`); set[`connectors.${k}`] = v[k].prefix; }
      if (v[k] && typeof v[k].enabled === 'boolean') set[`sources.${k}.enabled`] = v[k].enabled;
    }
  } else if (step === 'identity') {
    for (const k of ['name', 'email', 'slack_user_id', 'notion_user_id', 'timezone']) if (typeof v[k] === 'string' && v[k].trim()) set[`owner.${k}`] = v[k].trim();
    if (set['owner.timezone']) { try { new Intl.DateTimeFormat('en-US', { timeZone: set['owner.timezone'] }); } catch { throw new Error(`${set['owner.timezone']} is not a time zone`); } }
  } else if (step === 'scope') {
    if (v.initiative) set['sources.linear.scope'] = { initiative: String(v.initiative), team: '' };
    else if (v.team) set['sources.linear.scope'] = { initiative: '', team: String(v.team) };
    else throw new Error('pick one initiative or one team');
  } else if (step === 'privacy') {
    if (Array.isArray(v.calendars)) set['sources.gcal.calendars'] = v.calendars.map(String);
    if (Array.isArray(v.excludeFolders)) {
      // Keep exclusions the preview does not show (deeper folders set by hand).
      const shown = new Set(((readState(vault).probes.privacy || {}).folders || []).map((f) => f.id));
      const keep = getConfig(vault).sources.gdrive.exclude_folders.map(String).filter((id) => !shown.has(id));
      set['sources.gdrive.exclude_folders'] = [...new Set([...keep, ...v.excludeFolders.map(String)])];
    }
  } else if (step === 'schedule') {
    if (v.morning_at !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.morning_at)) throw new Error('morning time must be HH:MM'); set['schedule.morning_at'] = v.morning_at; }
    if (v.usage_share !== undefined) { if (!['light', 'normal', 'heavy'].includes(v.usage_share)) throw new Error('usage share must be light, normal or heavy'); set.usage_share = v.usage_share; }
    if (typeof v.enabled === 'boolean') set['schedule.enabled'] = v.enabled;
  } else if (step === 'wiki-shape') {
    // Written by wiki-shape.apply; saving here only marks the step done.
  } else if (step === 'first-run') {
    if (v.bootstrap_days !== undefined) { if (![3, 7, 14, 30].includes(Number(v.bootstrap_days))) throw new Error('first-run window is 3, 7, 14 or 30 days'); set.bootstrap_days = Number(v.bootstrap_days); }
  } else throw new Error(`unknown step ${step}`);
  if (Object.keys(set).length) writeValues(vault, set);
  if (step !== 'first-run') markDone(vault, step);
  return set;
}

// --- 6. Obsidian graph (A5) -----------------------------------------------------------------
// The graph shows wiki/ only, one color per wiki section, index and log hidden.
// Kit groups are remembered in .bot/state so the owner's own groups stay.
const PALETTE = [0x4f8ef7, 0xf2a93b, 0x5cc489, 0xe0627a, 0x9b7bf2, 0x3bc0c9, 0xd98c4a, 0x8fb83c, 0xc76bc2, 0x7a8da6, 0xe8d04c, 0x58a6ff];
function obsidianRunning() { return spawnSync('/usr/bin/pgrep', ['-x', 'Obsidian'], { encoding: 'utf8' }).status === 0; }
// opts.running: for tests (whether Obsidian is open); default asks pgrep.
function writeGraph(vault, { force = false, running } = {}) {
  if (!force && (running ?? obsidianRunning())) return { written: false, why: 'Close Obsidian to apply graph colors (it rewrites the file on exit).' };
  const dir = path.join(vault, '.obsidian');
  const file = path.join(dir, 'graph.json');
  let g = {}; try { g = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const kitFile = path.join(vault, '.bot', 'state', 'obsidian-kit.json');
  let prev = []; try { prev = JSON.parse(fs.readFileSync(kitFile, 'utf8')).queries || []; } catch {}
  const sections = getConfig(vault).wiki.sections.map(String);
  const kit = sections.map((s, i) => ({ query: `path:"wiki/${s}"`, color: { a: 1, rgb: PALETTE[i % PALETTE.length] } }));
  const mine = (g.colorGroups || []).filter((c) => !prev.includes(c.query) && !kit.some((k) => k.query === c.query));
  const next = { ...g, search: 'path:"wiki" -file:"index" -file:"log"', showTags: false, showAttachments: false, hideUnresolved: true, showOrphans: true, colorGroups: [...kit, ...mine] };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  fs.mkdirSync(path.dirname(kitFile), { recursive: true });
  fs.writeFileSync(kitFile, JSON.stringify({ queries: kit.map((k) => k.query) }, null, 2));
  markDone(vault, 'obsidian');
  return { written: true, groups: kit.length, kept: mine.length };
}

// --- 7. first run (15A) ------------------------------------------------------------------------
// The scheduled Morning run waits until the owner has started the first one.
// A vault that has ingested before has had its first run.
function firstRunStarted(vault) {
  return !!readState(vault).firstRunAt || fs.existsSync(path.join(vault, 'wiki', '.last-ingest'));
}
const markFirstRun = (vault) => writeState(vault, { firstRunAt: new Date().toISOString() });

function view(vault) {
  const st = readState(vault);
  const cfg = getConfig(vault);
  const o = cfg.owner;
  return {
    steps: STEPS, done: st.done || {}, probes: st.probes || {}, firstRunStarted: firstRunStarted(vault),
    obsidianRunning: obsidianRunning(),
    current: {
      connectors: cfg.connectors, enabled: Object.fromEntries(SOURCES.map((k) => [k, cfg.sources[k].enabled])),
      owner: { name: o.name, email: o.email, slack_user_id: o.slack_user_id, notion_user_id: o.notion_user_id, timezone: o.timezone },
      scope: cfg.sources.linear.scope, calendars: cfg.sources.gcal.calendars, excludeFolders: cfg.sources.gdrive.exclude_folders,
      schedule: { morning_at: cfg.schedule.morning_at, enabled: cfg.schedule.enabled }, usage_share: cfg.usage_share, bootstrap_days: cfg.bootstrap_days,
    },
    vaultName: path.basename(vault),
  };
}

module.exports = { STEPS, probeConnectors, probeIdentity, probeScope, probePrivacy, save, writeGraph, firstRunStarted, markFirstRun, view, readState };
