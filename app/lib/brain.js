// Brain — chat with your second-brain vault, and watch the bots that keep it.
//
//   POST /api/brain/chat            one chat turn  → { text, sessionId, costUsd, model, ms }
//   GET  /api/brain/bots            bot registry + each bot's latest run
//   POST /api/brain/bots/:id/run    start a run (async) → { runId }
//   GET  /api/brain/runs?bot=<id>   recent runs for one bot
//
// Chat is built to be cheap. Every turn is one `claude -p` call that:
//   * runs in an EMPTY cwd with --add-dir <vault>, so the vault's ~1000-line
//     CLAUDE.md is not re-read on every message — the prompt below says how to
//     navigate instead;
//   * loads NO MCP servers (--strict-mcp-config + empty config). Otherwise every
//     server on this machine starts up and a turn takes minutes (lib/topic.js
//     found this the hard way);
//   * can only Read / Grep / Glob, so it cannot change the vault;
//   * resumes the previous turn's session, so follow-ups keep context.
//
// Bots that need a source (Slack, Linear, …) are different: they DO load the
// claude.ai connectors, because that is the only way headless runs reach them.
// Measured 2026-10-01: plugin MCP tools (mcp__plugin_*) never load under -p;
// the claude.ai connector names do.
//
//   bot run lifecycle
//   ─────────────────
//   POST run ──▶ status:running ──▶ child exits ──▶ parse ──▶ ok | warn | error
//                     │                                          │
//                     └── log lines streamed into run.log ───────┴──▶ .bot/runs/<ts>-<bot>.json

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sync = require('./sync');
const { runIngest } = require('./ingest');
const { runVerify } = require('./verify-bot');
const { runBrief } = require('./brief-bot');
const { runResolve } = require('./resolve-bot');
const { runRestructure } = require('./restructure-bot');
const { runMorning, startScheduler, nextRun, settings: scheduleSettings } = require('./schedule');
const { syncSlackMcp } = require('./slack-mcp');
const { syncLinearMcp } = require('./linear-mcp');
const { syncNotionMcp } = require('./notion-mcp');
const { syncGcalMcp } = require('./gcal-mcp');
const { syncGdriveMcp } = require('./gdrive-mcp');
// Sources synced by "model presses buttons, code writes" (no model-written raw).
const { readOwner, getConfig } = require('./config');
const { botArgs, botEnv } = require('./claude-call');
const { script } = require('./kit');
const { tool, SETTINGS_URL, HEALTH_CALLS, judgeResult } = require('./connectors');
const { pressButtons, connectorVerdict } = require('./buttons');
const doctor = require('./doctor');
const setup = require('./setup');
const { Sessions } = require('./sessions');
let SESSIONS = null;
const { runRescope, staged: stagedScope } = require('./linear-scope');
const { resolveVault, STATE_DIR: INSTALL_STATE_DIR } = require('./install');

// The doctor's findings, cached briefly (the board polls every few seconds).
let CLAUDE_BIN = null;
let morningBlockedOn = null;
let doctorCache = { at: 0, findings: [] };
function doctorNow(force = false) {
  if (force || Date.now() - doctorCache.at > 15000) doctorCache = { at: Date.now(), findings: doctor.check(VAULT, { claudeBin: CLAUDE_BIN }) };
  return doctorCache.findings;
}
// Before a bot runs: an error that names it stops it, with the fix.
function gated(run, botId) {
  const blk = doctor.blockers(doctorNow(true), botId);
  if (!blk.length) return true;
  finish(run, 'error', `Setup issue: ${blk[0].message} ${blk[0].fix}`.trim(), { kind: 'setup', findings: blk });
  return false;
}
const { dayOf } = require('./time');
const BUTTON_SYNCS = { slack: syncSlackMcp, linear: syncLinearMcp, notion: syncNotionMcp, gcal: syncGcalMcp, gdrive: syncGdriveMcp };

// No default vault: `second-brain setup` records it (lib/install.js).
const VAULT = resolveVault();
const STATE_DIR = INSTALL_STATE_DIR;
// A neutral folder for calls that need no vault (the health probe).
const CHAT_CWD = path.join(STATE_DIR, 'brain-cwd');
const RUNS_DIR = path.join(VAULT, '.bot', 'runs');

fs.mkdirSync(CHAT_CWD, { recursive: true });

// A stale ANTHROPIC_API_KEY beats the claude.ai login and 401s; botEnv strips it.
const claudeEnv = () => botEnv();


// --- bots ------------------------------------------------------------------
// One entry per bot. `kind` says what it costs to run:
//   model  — calls claude (shows a $ cost)
//   bash   — runs a vault script, no tokens
//   later  — designed, not built yet; shown so the board tells the truth


const BOTS = [
  {
    id: 'morning', name: 'Morning run', kind: 'model',
    blurb: 'The scheduled chain: every sync, then Resolve (your Needs-You ticks), then Brief, then Ingest when due (60+ new files or 3+ days), then Verify after an ingest. Runs once a day at schedule.morning_at in config.yaml, or on wake if the laptop slept through it.',
    run: (run, claudeBin) => runMorning(run, { vault: VAULT, logLine, finish, isRunning, runBot: (id, body) => runBotAndWait(id, claudeBin, body) }),
  },
  {
    id: 'rescope', name: 'Linear rescope', kind: 'model',
    blurb: 'Rebuilds the set of Linear projects the sync covers (sources.linear.scope: an initiative and its sub-tree, or a team). Haiku presses the list buttons; code counts. Runs weekly in the Morning run.',
    run: (run, claudeBin, body = {}) => runRescope(run, { claudeBin, vault: VAULT, env: claudeEnv(), logLine, finish }, body),
  },
  {
    id: 'health', name: 'Health', kind: 'model',
    blurb: 'Can each source be reached right now? One cheap call per connector.',
    run: runHealth,
  },
  {
    id: 'lint', name: 'Lint', kind: 'bash',
    blurb: 'Dead links, raw purity and annotations in raw. A kit script, no tokens.',
    run: (run) => runScript(run, script('linkrot-lint.sh'), summarizeLint),
  },
  {
    id: 'deltas', name: 'Deltas', kind: 'bash',
    blurb: 'What changed since the last ingest, per source. No tokens.',
    run: (run) => runScript(run, script('delta-walk.sh'), summarizeDeltas),
  },
  // One sync bot per source, so each can be run and watched on its own.
  ...Object.entries(sync.SOURCES).map(([key, src]) => ({
    // The model only presses the connector's buttons; the runner picks every
    // call and writes the files (lib/<source>-mcp.js).
    id: `sync-${key}`, name: `Sync ${src.name}`, kind: 'model',
    blurb: `${src.name} via the claude.ai connector. Haiku calls the tools; code writes the files, so nothing in raw is model-written.`,
    run: (run, claudeBin, body = {}) => BUTTON_SYNCS[key](run, { claudeBin, vault: VAULT, env: claudeEnv(), logLine, finish, src, body }),
  })),
  {
    id: 'verify', name: 'Verify', kind: 'model',
    blurb: 'Checks the wiki against what ingest says it did: structure, staleness, lint, and a sampled coverage check (~$0.5). Queues contradictions and gaps in Needs-You.md.',
    run: (run, claudeBin) => runVerify(run, { claudeBin, vault: VAULT, env: claudeEnv(), logLine, finish, summarizeLint }),
  },
  {
    id: 'ingest', name: 'Ingest', kind: 'model',
    blurb: 'Fold new raw files into wiki pages, in ~45KB parts so every message is read. Holds sources whose sync failed. ~$0.5/part, $40 cap; a stopped run resumes.',
    run: (run, claudeBin, body = {}) => runIngest(run, {
      claudeBin, vault: VAULT, env: claudeEnv(), logLine, finish, latestFor,
      syncBotIds: Object.keys(sync.SOURCES).map((k) => `sync-${k}`),
    }, { files: Array.isArray(body.files) ? body.files.map(String) : [], maxParts: Number(body.maxParts) || 0, hints: body.hints && typeof body.hints === 'object' ? body.hints : {} }),
  },
  {
    id: 'resolve', name: 'Resolve', kind: 'model',
    blurb: 'Applies your ticks in Needs-You.md: a picked claim edits the wiki pages that state the other one (Sonnet, ~$0.2 each, EDIT only, originals backed up), "re-ingest" runs a named-file Ingest, "ignore" just records it.',
    run: (run, claudeBin) => runResolve(run, { claudeBin, vault: VAULT, env: claudeEnv(), logLine, finish, runBot: (id, body) => runBotAndWait(id, claudeBin, body) }),
  },
  {
    id: 'restructure', name: 'Restructure', kind: 'model',
    blurb: 'Supervised. Splits the biggest append-log wiki page (over 150KB) into a hub (what is true now: Current state, Timeline, Open questions by Opus, ~$3) and a verbatim -history page. Stages it in .bot/restructure/ for you; tick "apply" in its report.md and run again to apply. Never in the Morning run.',
    run: (run, claudeBin, body = {}) => runRestructure(run, { claudeBin, vault: VAULT, env: claudeEnv(), logLine, finish }, body),
  },
  {
    id: 'brief', name: 'Brief', kind: 'model',
    blurb: "Where to focus today. Reads what came in across Slack, Linear and Notion plus today's calendar and says where to focus, with a source link on every line (Sonnet, ~$0.3). Writes Brief.md. Refreshes the calendar first if it is over 3h old (~$1).",
    run: async (run, claudeBin, body = {}) => {
      // The brief is for today, so today's calendar has to be fresh. The sync
      // runs as its own recorded run; if it fails Brief still renders, flagged.
      let refreshed = null;
      const calFile = path.join(VAULT, 'gcal', `${localDay()}.md`);
      const age = fs.existsSync(calFile) ? Date.now() - fs.statSync(calFile).mtimeMs : Infinity;
      if (!body.noRefresh && age > 3 * 3600e3 && claudeBin) {
        const calBot = BOTS.find((b) => b.id === 'sync-gcal');
        const child = newRun(calBot);
        logLine(run, 'today\'s calendar is stale; running Sync Calendar first…');
        await Promise.resolve(calBot.run(child, claudeBin, {})).catch((e) => failRun(child, e));
        refreshed = { status: child.status, summary: child.summary, costUsd: child.costUsd };
        logLine(run, `Sync Calendar: ${child.status} · ${child.summary}`);
      }
      return runBrief(run, { vault: VAULT, logLine, finish, latestFor, owner: readOwner(VAULT), ownerName: readOwner(VAULT).name, refreshed, claudeBin, env: claudeEnv(), run, noSynth: body.noSynth });
    },
  },
];

const runs = new Map(); // runId -> run (in memory, newest kept per bot)
let seq = 0;

// Today in the owner's zone (config.yaml owner.timezone).
function localDay(d = new Date()) { return dayOf(d, getConfig(VAULT).owner.timezone); }
function isRunning(botId) { return [...runs.values()].some((r) => r.bot === botId && r.status === 'running'); }

// Start a bot as its own recorded run and resolve with that run when it ends.
async function runBotAndWait(botId, claudeBin, body = {}) {
  const bot = BOTS.find((b) => b.id === botId);
  const run = newRun(bot);
  if (!gated(run, botId)) return run;
  await Promise.resolve(bot.run(run, claudeBin, body)).catch((e) => failRun(run, e));
  if (run.status === 'running') finish(run, 'error', 'bot returned without finishing');
  return run;
}

// The timer (lib/schedule.js). Called once by server.js after it starts listening.
// .bot/lock (OV3): while the app runs, it holds this file with a heartbeat.
// The kit block in CLAUDE.md tells chat sessions: a lock younger than 15
// minutes = the app owns sync/ingest; ask it (`second-brain run`) instead.
const LOCK = () => path.join(VAULT, '.bot', 'lock');
function heartbeat() {
  try {
    fs.mkdirSync(path.dirname(LOCK()), { recursive: true });
    const running = [...runs.values()].filter((r) => r.status === 'running').map((r) => r.bot);
    fs.writeFileSync(LOCK(), `${JSON.stringify({ pid: process.pid, port: Number(process.env.SECOND_BRAIN_PORT || 19300), heartbeat: new Date().toISOString(), running })}\n`);
  } catch {}
}
function releaseLock() {
  try { const l = JSON.parse(fs.readFileSync(LOCK(), 'utf8')); if (l.pid === process.pid) fs.rmSync(LOCK()); } catch {}
}

function start(claudeBin) {
  CLAUDE_BIN = claudeBin;
  heartbeat();
  setInterval(heartbeat, 60000).unref();
  if (claudeBin) SESSIONS = new Sessions({ vault: VAULT, stateDir: STATE_DIR, claudeBin });
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { if (SESSIONS) SESSIONS.stopAll(); releaseLock(); process.exit(0); });
  process.once('exit', releaseLock);
  for (const f of doctorNow(true)) if (f.level !== 'info') console.log(`doctor ${f.level}: ${f.message}${f.fix ? ` Fix: ${f.fix}` : ''}`);
  if (!claudeBin) return;
  startScheduler({
    vault: VAULT,
    startMorning: () => {
      if (isRunning('morning')) return;
      // Blocked by setup: no run record every 5-minute tick; one log line a
      // day, and the Today page shows the issue. It runs once it is fixed.
      const blk = doctor.blockers(doctorNow(true), 'morning');
      if (blk.length) {
        const day = new Date().toDateString();
        if (morningBlockedOn !== day) { morningBlockedOn = day; console.log(`Morning run held: ${blk[0].message}`); }
        return;
      }
      const bot = BOTS.find((b) => b.id === 'morning');
      const run = newRun(bot);
      logLine(run, 'started by the schedule');
      Promise.resolve(bot.run(run, claudeBin)).catch((e) => failRun(run, e));
    },
  });
}

function stampNow() { return new Date().toISOString(); }

function newRun(bot) {
  const id = `${Date.now().toString(36)}${(seq++).toString(36)}`;
  const run = { id, bot: bot.id, status: 'running', startedAt: stampNow(), endedAt: null, costUsd: 0, summary: '', detail: null, log: [] };
  runs.set(id, run);
  return run;
}

function logLine(run, text) {
  run.log.push(`${new Date().toTimeString().slice(0, 8)} ${text}`);
  if (run.log.length > 400) run.log.splice(0, run.log.length - 400);
}

// A thrown error ends the run. kind 'auth' (a connector is not connected)
// becomes a Your-move card with the fix link (todoFor).
function failRun(run, e) {
  const detail = e && e.kind ? { kind: e.kind, source: e.source, fix: e.fix } : null;
  finish(run, 'error', (e && e.message) || String(e), detail, (e && e.cost) || 0);
}

function finish(run, status, summary, detail, costUsd = 0) {
  Object.assign(run, { status, summary, detail, costUsd, endedAt: stampNow() });
  logLine(run, `${status.toUpperCase()}: ${summary}`);
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const name = `${run.startedAt.replace(/[:.]/g, '-')}-${run.bot}.json`;
    fs.writeFileSync(path.join(RUNS_DIR, name), JSON.stringify(run, null, 2));
  } catch (e) {
    run.log.push(`(could not save run record: ${e.message})`);
  }
}

// Code decides each status from the stream; the model only makes the calls.
// (Asked to report statuses itself, haiku said "5/5 ok" with no connector
// loaded at all, 2026-10-09.)
async function runHealth(run, claudeBin) {
  const owner = readOwner(VAULT);
  const want = Object.entries(HEALTH_CALLS).map(([k, [name, args]]) => ({ k, t: tool(VAULT, k, name), args: args(owner) }));
  const prompt = ['Health probe. Call each tool below exactly once with exactly these arguments (load each with ToolSearch "select:<tool>" first). Call nothing else. Do not repeat any result. Then reply DONE.',
    ...want.map((w) => `  ${w.t} ${JSON.stringify(w.args)}`)].join('\n');
  logLine(run, `probing ${want.length} connectors (haiku presses, code judges)…`);
  const r = await pressButtons({ claudeBin, vault: CHAT_CWD, env: claudeEnv(), logLine }, run, prompt, 0.5, want.map((w) => w.t));
  const status = {}, reasons = {};
  for (const w of want) {
    const c = r.calls.find((x) => x.name === w.t);
    const j = judgeResult(c);
    if (j.status !== 'none') { status[w.k] = j.status; if (j.why) reasons[w.k] = j.why; continue; }
    const v = connectorVerdict(r.servers, r.searches, [w.t]);
    status[w.k] = v ? 'auth' : 'error';
    reasons[w.k] = v ? `${v.server}: ${v.problem}` : 'no result came back';
  }
  const bad = Object.entries(status).filter(([, v]) => v !== 'ok');
  for (const [k, v] of Object.entries(status)) logLine(run, `${k}: ${v}${reasons[k] ? ` (${reasons[k]})` : ''}`);
  const summary = bad.length ? `${want.length - bad.length}/${want.length} ok · ${bad.map(([k, v]) => `${k} ${v}`).join(', ')}` : `${want.length}/${want.length} ok`;
  const auth = bad.filter(([, v]) => v === 'auth').map(([k]) => k);
  const detail = { sources: status, reasons, ...(auth.length ? { kind: 'auth', source: auth.join(','), fix: SETTINGS_URL } : {}) };
  finish(run, bad.length ? (auth.length ? 'error' : 'warn') : 'ok', auth.length ? `${summary}. Open claude.ai → Settings → Connectors to connect ${auth.join(', ')}.` : summary, detail, r.cost);
}

function runScript(run, script, summarize) {
  return new Promise((resolve) => {
    if (!fs.existsSync(script)) { finish(run, 'error', `missing ${script}`); return resolve(); }
    logLine(run, `bash ${path.basename(script)} --vault ${VAULT}`);
    const child = spawn('/bin/bash', [script, '--vault', VAULT], { cwd: VAULT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => {
      out.split('\n').filter(Boolean).slice(-60).forEach((l) => logLine(run, l));
      const { status, summary } = summarize(out, code);
      finish(run, status, summary, { exit: code });
      resolve();
    });
  });
}

function summarizeLint(out, code) {
  // Read each section's own count line. The script ends with a generic
  // "OK: no findings" footer even when sections above it found things, so the
  // footer is ignored on purpose.
  const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : 0; };
  const malformed = (out.split('## 4.')[1] || '').split('## 5.')[0].split('\n').filter((l) => l.startsWith('[[')).length;
  const found = [
    ['dead source links', num(/ACTIONABLE \(dead \+ UNannotated\) occurrences: (\d+)/)],
    // One dead wiki->wiki link is the <name> template placeholder, expected.
    ['dead wiki links', Math.max(0, num(/Total dead wiki->wiki links: (\d+)/) - 1)],
    ['malformed links', malformed],
    ['wiki links in raw', num(/backlinks \(should be 0\): (\d+)/)],
    ['raw files w/ annotations', num(/total raw files carrying suspected annotations: (\d+)/)],
  ].filter(([, n]) => n > 0);
  if (code !== 0) return { status: 'error', summary: `lint exited ${code}` };
  if (!found.length) return { status: 'ok', summary: 'no findings' };
  return { status: 'warn', summary: found.map(([w, n]) => `${n} ${w}`).join(' · ') };
}

function summarizeDeltas(out, code) {
  const line = (out.match(/Deltas walked:[^\n]*/) || [''])[0];
  if (code !== 0 || !line) return { status: 'error', summary: `delta-walk exited ${code}` };
  const parts = line.replace('Deltas walked:', '').split(',').map((s) => s.trim());
  const nonzero = parts.filter((s) => /=\d+$/.test(s) && !/=0$/.test(s));
  return { status: 'ok', summary: nonzero.length ? nonzero.join(' · ') : 'nothing new since last ingest' };
}

function latestFor(botId) {
  let best = null;
  for (const r of runs.values()) if (r.bot === botId && (!best || r.startedAt > best.startedAt)) best = r;
  if (best) return best;
  // After a server restart, fall back to the newest saved record.
  try {
    const f = fs.readdirSync(RUNS_DIR).filter((n) => n.endsWith(`-${botId}.json`)).sort().pop();
    if (f) return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
  } catch {}
  return null;
}

// --- "your move" --------------------------------------------------------------
// What a bot is waiting on from the owner, so the board can show it instead of
// a bare log. Files are vault-relative; the UI views them via /api/brain/file.

const RESTRUCTURE_DIR = path.join('.bot', 'restructure');

function stagedRestructures() {
  const root = path.join(VAULT, RESTRUCTURE_DIR);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    // -applied- and -stale- folders are finished stagings, kept for the record.
    .filter((d) => !d.includes('-applied-') && !d.includes('-stale-') && fs.existsSync(path.join(root, d, 'report.md')))
    .map((slug) => {
      const rep = fs.readFileSync(path.join(root, slug, 'report.md'), 'utf8');
      const title = (rep.match(/^# Restructure: (.+)$/m) || [])[1] || slug;
      const sizes = (rep.match(/^Staged .*$/m) || [''])[0];
      const want = (rep.match(/^Old page sha256: (\w+)/m) || [])[1];
      let stale = false;
      try { stale = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(VAULT, title), 'utf8')).digest('hex') !== want; } catch {}
      return { slug, title, sizes, stale, ticked: /^- \[x\] apply this restructure/im.test(rep) };
    });
}

function needsYouOpen() {
  try {
    const t = fs.readFileSync(path.join(VAULT, 'Needs-You.md'), 'utf8');
    const open = t.split(/^## Resolved/m)[0];
    return (open.match(/^### /gm) || []).length;
  } catch { return 0; }
}

function todoFor(id) {
  if (id === 'restructure') {
    const staged = stagedRestructures();
    if (!staged.length) return null;
    return {
      text: staged.length === 1 ? 'A split is staged and waiting for your review.' : `${staged.length} splits are staged and waiting for your review.`,
      items: staged.map((s) => ({
        title: s.title,
        note: s.stale ? `${s.sizes} OUT OF DATE: ingest changed the page after this was staged. Re-stage (Opus, ~$1.40) to review the current version.` : s.sizes,
        files: ['report.md', 'hub.md', 'history.md'].map((f) => ({ label: f.replace('.md', ''), path: path.join(RESTRUCTURE_DIR, s.slug, f) })),
        actions: [
          { label: 'Compare', kind: 'compare', slug: s.slug },
          s.stale
            ? { label: 'Re-stage', kind: 'restructure-apply', slug: s.slug, confirm: `Re-stage ${s.title} from the current page? Opus, about $1.40. Nothing is applied yet.` }
            : { label: 'Apply', kind: 'restructure-apply', slug: s.slug, confirm: `Apply the ${s.title} split? The old page is backed up first.` }],
      })),
    };
  }
  // A Linear scope that waits for the owner: the first one, or a blocked one.
  if (id === 'rescope') {
    const st = stagedScope(VAULT);
    if (!st) return null;
    const c = st.cross;
    const counts = c ? `Walked ${c.walked} project(s); the cross-check counted ${c.union}${c.directKnown ? '' : ' (without the root\'s direct projects)'}.` : `Walked ${st.scope.project_count} project(s).`;
    return st.blocked
      ? { text: `The Linear rescope did not change the scope: ${(st.problems || []).join('; ')}`, items: [{ title: 'Linear scope', actions: [{ label: 'Retry', kind: 'run', slug: 'rescope' }] }] }
      : { text: `${counts} ${st.scope.initiatives.length} initiative(s). Use this as the Linear scope?`, items: [{ title: 'Linear scope', actions: [
        { label: 'Use this scope', kind: 'run', slug: 'rescope', body: { accept: true }, confirm: `Sync these ${st.scope.project_count} Linear projects from now on?` },
        { label: 'Retry', kind: 'run', slug: 'rescope' },
      ] }] };
  }
  // A sync that stopped because its connector is not connected.
  if (/^sync-/.test(id) || id === 'health') {
    const last = latestFor(id);
    const d = last && last.detail;
    if (!last || last.status !== 'error' || !d || d.kind !== 'auth') return null;
    const bot = BOTS.find((b) => b.id === id);
    return {
      text: last.summary,
      items: [{ title: bot ? bot.name : id, actions: [
        { label: 'Open claude.ai connectors', kind: 'open-url', url: d.fix },
        { label: 'Run again', kind: 'run', slug: id },
        { label: 'Fix in a session', kind: 'session', slug: 'connector', body: { bot: id } },
      ] }],
    };
  }
  // Verify writes Needs-You.md and Resolve applies it; the move belongs to Resolve only.
  if (id === 'resolve') {
    const n = needsYouOpen();
    if (!n) return null;
    return {
      text: `${n} item(s) are waiting for your answer. Pick one choice per item on the Resolve page (or tick it in Needs-You.md in Obsidian), then press Apply my answers. The Morning run also applies them.`,
      items: [{ title: 'Needs-You.md', actions: [{ label: 'Answer them', kind: 'goto', slug: 'resolve' }], files: [{ label: 'file', path: 'Needs-You.md' }], obsidian: 'Needs-You.md' }],
    };
  }
  return null;
}

// Only files the board links to can be read through the API.
function viewableFile(rel) {
  const norm = path.normalize(String(rel || '')).replace(/^[/\\]+/, '');
  if (norm.includes('..')) return null;
  const ok = norm === 'Needs-You.md' || norm === 'Brief.md' || (norm.startsWith(RESTRUCTURE_DIR + path.sep) && norm.endsWith('.md'));
  return ok ? path.join(VAULT, norm) : null;
}

function tickRestructure(slug) {
  if (!/^[\w.-]+$/.test(slug)) throw new Error('bad slug');
  const f = path.join(VAULT, RESTRUCTURE_DIR, slug, 'report.md');
  const rep = fs.readFileSync(f, 'utf8');
  if (!/^- \[ \] apply this restructure/m.test(rep) && !/^- \[x\] apply this restructure/im.test(rep)) throw new Error('report.md has no apply box');
  fs.writeFileSync(f, rep.replace(/^- \[ \] apply this restructure/m, '- [x] apply this restructure'));
}

// --- Session kinds (A2). The SERVER decides each kind's first message and
// its outcome buttons from the item; the browser only says which kind and
// which item. An outcome button is an app action: the app writes the result
// (a tick, a repair, a run), then closes the session. The model explains and
// suggests; it never writes the outcome.
const SUGGEST_RULE = (labels) => labels.length ? `When you recommend one of the app's buttons, end your reply with one line: SUGGEST: <label>, where <label> is exactly one of: ${labels.map((l) => `"${l}"`).join(', ')}. The owner presses the button; you never do the action yourself.` : '';
const SESSION_BASE = 'You are in a Second Brain app session in the owner\'s vault. Read the vault CLAUDE.md first. Explain in short, plain sentences. Never edit a raw folder or a watermark file. Never tick a box in Needs-You.md.';

function sessionSpec(kind, item = {}) {
  if (kind === 'repair') {
    const f = doctorNow(true).filter((x) => x.level !== 'info');
    const outcomes = [{ label: 'Run Repair', action: { type: 'repair' } }, { label: 'Check again', action: { type: 'doctor' } }];
    return { title: 'Repair setup', outcomes, prompt: [SESSION_BASE, 'Goal: help the owner fix what stops the bots. The app\'s checks found:',
      ...(f.length ? f.map((x) => `- [${x.level}] ${x.message} Fix: ${x.fix}`) : ['- nothing']),
      'For each finding, say what it means and the exact fix. "Run Repair" creates missing folders and starter files only (it never overwrites). Config values are fixed on the Setup page or in config.yaml.', SUGGEST_RULE(outcomes.map((o) => o.label))].join('\n') };
  }
  if (kind === 'connector') {
    const bot = BOTS.find((b) => b.id === item.bot);
    if (!bot) throw new Error('no such bot');
    const last = latestFor(bot.id) || {};
    const outcomes = [{ label: 'Run again', action: { type: 'run', bot: bot.id } }];
    return { title: `Fix ${bot.name}`, outcomes, prompt: [SESSION_BASE, `Goal: help the owner get ${bot.name} working. Its last run ended: ${last.status || 'never ran'}: ${last.summary || ''}`,
      'Explain the likely cause and the fix. A connector that is not connected is fixed in claude.ai → Settings → Connectors (https://claude.ai/settings/connectors). You may test a connector tool once to check.', SUGGEST_RULE(outcomes.map((o) => o.label))].join('\n') };
  }
  if (kind === 'needs') {
    const it = needsOpenItems().find((x) => x.id === item.id);
    if (!it) throw new Error('no such open Needs-You item');
    const outcomes = it.boxes.map((b) => ({ label: b.label, action: { type: 'tick', id: it.id, label: b.label } }));
    return { title: `Look into ${it.id}`, outcomes, item: { id: it.id }, prompt: [SESSION_BASE, `Goal: help the owner answer this Needs-You item (${it.id}):`, it.text,
      `The answer choices are: ${it.boxes.map((b) => `"${b.label}"`).join(', ')}.`,
      'Read the wiki pages and raw files the item names, show the evidence with file links, and say which choice the sources support and why.', SUGGEST_RULE(outcomes.map((o) => o.label))].join('\n') };
  }
  if (kind === 'restructure') {
    const st = stagedRestructures().find((x) => x.slug === item.slug);
    if (!st) throw new Error('no such staged restructure');
    const outcomes = [{ label: st.stale ? 'Re-stage' : 'Apply', action: { type: 'restructure', slug: st.slug } }];
    return { title: `Ask about ${st.title}`, outcomes, item: { slug: st.slug }, prompt: [SESSION_BASE, `Goal: help the owner review a staged restructure of ${st.title}. The staged files are in ${path.join(RESTRUCTURE_DIR, st.slug)}: report.md (what moves and why), hub.md (the new page), history.md (the verbatim history).`,
      'Answer the owner\'s questions about the change. Check that nothing was lost, using report.md.', SUGGEST_RULE(outcomes.map((o) => o.label))].join('\n') };
  }
  if (kind === 'chat') return { title: item.title || 'Vault chat', outcomes: [], prompt: '' };
  throw new Error(`unknown session kind ${kind}`);
}

// Do one outcome's app action. Returns a short summary for the session.
async function runOutcome(action, claudeBin) {
  if (action.type === 'repair') { const made = doctor.repair(VAULT); doctorNow(true); return made.length ? `created ${made.join(', ')}` : 'nothing was missing'; }
  if (action.type === 'doctor') { const e = doctorNow(true).filter((x) => x.level === 'error'); return e.length ? `${e.length} issue(s) left` : 'nothing stops the bots'; }
  if (action.type === 'tick') { answerNeed(action.id, action.label); return `ticked "${action.label}" on ${action.id}; Resolve applies it`; }
  if (action.type === 'run' || action.type === 'restructure') {
    const id = action.type === 'run' ? action.bot : 'restructure';
    if (isRunning(id)) throw new Error(`${id} is already running`);
    if (action.type === 'restructure') tickRestructure(action.slug);
    const bot = BOTS.find((b) => b.id === id);
    const run = newRun(bot);
    if (gated(run, id)) Promise.resolve(bot.run(run, claudeBin, {})).catch((e) => failRun(run, e));
    return `started ${bot.name}`;
  }
  throw new Error('unknown outcome');
}

// --- Needs-You answered in the app ---------------------------------------------
// The app ticks the same boxes the owner would tick in Obsidian, by editing the
// item's box lines in place (any notes under items are left untouched). Resolve
// then applies them exactly as it would a tick made by hand.

const NEEDS = () => path.join(VAULT, 'Needs-You.md');

function needsOpenItems() {
  let text = '';
  try { text = fs.readFileSync(NEEDS(), 'utf8'); } catch { return []; }
  const { parseNeedsYou } = require('./verify-bot');
  return [...parseNeedsYou(text).values()].filter((it) => it.section !== 'Resolved');
}

function answerNeed(id, label) {
  if (!/^[cg]-[0-9a-f]{7}$/.test(id)) throw new Error('bad item id');
  const lines = fs.readFileSync(NEEDS(), 'utf8').split('\n');
  let inItem = false, found = false, hit = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{2,3} /.test(l)) { inItem = l.startsWith(`### ${id} ·`); if (inItem) found = true; continue; }
    if (!inItem) continue;
    const b = l.match(/^- \[( |x)\] (.+)$/i);
    if (!b) continue;
    // Clicking the picked box again clears it; picking another moves the tick.
    const on = b[2] === label ? !(b[1].toLowerCase() === 'x') : false;
    if (b[2] === label) hit = true;
    lines[i] = `- [${on ? 'x' : ' '}] ${b[2]}`;
  }
  if (!found) throw new Error('item not found (Verify may have rewritten the file; reload)');
  if (!hit) throw new Error('no such choice on that item');
  fs.writeFileSync(NEEDS(), lines.join('\n'));
}

function botsView() {
  return BOTS.map(({ id, name, kind, blurb }) => ({ id, name, kind, blurb, last: latestFor(id), todo: todoFor(id) }));
}

// --- HTTP ------------------------------------------------------------------
// Returns true if it handled the request. Auth (origin + token) is enforced by
// server.js before this is reached.

async function handle(req, res, url, { json, readBody, claudeBin }) {
  const p = url.pathname;
  if (!p.startsWith('/api/brain/') && !p.startsWith('/api/setup') && !p.startsWith('/api/sessions')) return false;


  // --- Sessions (T19): real Claude Code in a pty, streamed over /ws.
  if (p === '/api/sessions' && req.method === 'GET') return json(res, 200, { sessions: SESSIONS ? SESSIONS.list() : [], max: getConfig(VAULT).sessions.max_running }), true;
  if (p === '/api/sessions' && req.method === 'POST') {
    if (!SESSIONS) return json(res, 500, { error: 'claude CLI not found' }), true;
    const b = await readBody(req);
    const model = ['opus', 'sonnet', 'haiku'].includes(b.model) ? b.model : 'sonnet';
    try {
      const spec = sessionSpec(String(b.kind || ''), b.item || {});
      // One open session per item: open the existing one instead of a second.
      const key = JSON.stringify([b.kind, spec.item || b.item || null]);
      const same = b.kind !== 'chat' && SESSIONS.list().find((x) => x.state !== 'done' && JSON.stringify([x.kind, x.item]) === key);
      if (same) return json(res, 200, { session: SESSIONS.open(same.id).toJSON() }), true;
      return json(res, 200, { session: SESSIONS.create({ ...spec, kind: b.kind, item: spec.item || b.item || null, model }).toJSON() }), true;
    } catch (e) { return json(res, 400, { error: e.message }), true; }
  }
  const om = p.match(/^\/api\/sessions\/([0-9a-f]{10})\/outcome$/);
  if (om && req.method === 'POST') {
    const s = SESSIONS && SESSIONS.get(om[1]);
    if (!s) return json(res, 404, { error: 'no such session' }), true;
    const b = await readBody(req);
    const o = (s.outcomes || []).find((x) => x.label === b.label);
    if (!o) return json(res, 400, { error: 'no such outcome for this session' }), true;
    try { const summary = await runOutcome(o.action, claudeBin); s.finish(o.label); return json(res, 200, { summary, session: s.toJSON() }), true; } catch (e) { return json(res, 400, { error: e.message }), true; }
  }
  if (p.match(/^\/api\/sessions\/[0-9a-f]{10}\/transcript$/) && req.method === 'GET') {
    const id = p.split('/')[3];
    const f = path.join(VAULT, '.bot', 'sessions', `${id}.jsonl`);
    const lines = [];
    try {
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        let j; try { j = JSON.parse(l); } catch { continue; }
        const m = j.message; if (!m || (j.type !== 'user' && j.type !== 'assistant')) continue;
        const text = typeof m.content === 'string' ? m.content : (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (text.trim()) lines.push({ who: j.type, text });
      }
    } catch { return json(res, 404, { error: 'no transcript kept for this session' }), true; }
    return json(res, 200, { lines }), true;
  }
  const sm = p.match(/^\/api\/sessions\/([0-9a-f]{10})\/(open|sleep|close)$/);
  if (sm && req.method === 'POST') {
    const s = SESSIONS && SESSIONS.get(sm[1]);
    if (!s) return json(res, 404, { error: 'no such session' }), true;
    const b = await readBody(req);
    try {
      if (sm[2] === 'open') SESSIONS.open(s.id, b.cols, b.rows);
      else if (sm[2] === 'sleep') s.sleep();
      else s.finish(String(b.outcome || 'closed').slice(0, 80));
    } catch (e) { return json(res, 400, { error: e.message }), true; }
    return json(res, 200, { session: s.toJSON() }), true;
  }

  // --- Setup page (T14). Probes press buttons; code reads; saves edit config as text.
  if (p === '/api/setup' && req.method === 'GET') return json(res, 200, setup.view(VAULT)), true;
  if (p === '/api/setup/probe' && req.method === 'POST') {
    const body = await readBody(req);
    const fn = { connectors: setup.probeConnectors, identity: setup.probeIdentity, scope: setup.probeScope, privacy: setup.probePrivacy }[body.step];
    if (!fn) return json(res, 400, { error: 'unknown probe' }), true;
    if (!claudeBin) return json(res, 500, { error: 'claude CLI not found' }), true;
    const run = newRun({ id: `setup-${body.step}` });
    try {
      const r = await fn({ claudeBin, vault: VAULT, env: claudeEnv(), logLine }, run);
      finish(run, 'ok', `${body.step} probe done`, null, r.cost);
      json(res, 200, { result: r.result, view: setup.view(VAULT) });
    } catch (e) { failRun(run, e); json(res, 200, { error: e.message, kind: e.kind, fix: e.fix }); }
    return true;
  }
  if (p === '/api/setup/save' && req.method === 'POST') {
    const body = await readBody(req);
    try { const set = setup.save(VAULT, body.step, body.values || {}); doctorNow(true); json(res, 200, { set, view: setup.view(VAULT) }); } catch (e) { json(res, 400, { error: e.message }); }
    return true;
  }
  if (p === '/api/setup/obsidian' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, { ...setup.writeGraph(VAULT, { force: !!body.force }), view: setup.view(VAULT) }), true;
  }
  if (p === '/api/setup/first-run' && req.method === 'POST') {
    const body = await readBody(req);
    try { setup.save(VAULT, 'first-run', { bootstrap_days: body.bootstrap_days }); } catch (e) { return json(res, 400, { error: e.message }), true; }
    if (isRunning('morning')) return json(res, 409, { error: 'the Morning run is already running' }), true;
    const bot = BOTS.find((b) => b.id === 'morning');
    const run = newRun(bot);
    logLine(run, 'first run, started from Setup');
    setup.markFirstRun(VAULT);
    if (gated(run, 'morning')) Promise.resolve(bot.run(run, claudeBin, {})).catch((e) => failRun(run, e));
    return json(res, 200, { runId: run.id, view: setup.view(VAULT) }), true;
  }

  // Repair creates only what is missing (folders, starter wiki files); it
  // never overwrites. The session-based Repair (Phase 2) builds on this.
  if (p === '/api/brain/doctor/repair' && req.method === 'POST') {
    const made = doctor.repair(VAULT);
    const left = doctorNow(true).filter((f) => f.level === 'error');
    json(res, 200, { made, left });
    return true;
  }

  if (p === '/api/brain/bots' && req.method === 'GET') {
    CLAUDE_BIN = CLAUDE_BIN || claudeBin;
    const setup = doctorNow().filter((f) => f.level !== 'info');
    json(res, 200, { vault: VAULT, bots: botsView(), setup, schedule: { ...scheduleSettings(VAULT), next: nextRun(VAULT) } });
    return true;
  }

  const m = p.match(/^\/api\/brain\/bots\/([a-z-]+)\/run$/);
  if (m && req.method === 'POST') {
    const bot = BOTS.find((b) => b.id === m[1]);
    if (!bot) return json(res, 404, { error: 'no such bot' }), true;
    if (!bot.run) return json(res, 409, { error: `${bot.name} is not built yet` }), true;
    const busy = [...runs.values()].find((r) => r.bot === bot.id && r.status === 'running');
    if (busy) return json(res, 409, { error: `${bot.name} is already running`, runId: busy.id }), true;
    const body = await readBody(req).catch(() => ({}));
    const run = newRun(bot);
    CLAUDE_BIN = CLAUDE_BIN || claudeBin;
    if (gated(run, bot.id)) Promise.resolve(bot.run(run, claudeBin, body || {})).catch((e) => failRun(run, e));
    json(res, 200, { runId: run.id });
    return true;
  }

  if (p === '/api/brain/file' && req.method === 'GET') {
    const full = viewableFile(url.searchParams.get('path'));
    if (!full || !fs.existsSync(full)) return json(res, 404, { error: 'not viewable' }), true;
    json(res, 200, { path: path.relative(VAULT, full), text: fs.readFileSync(full, 'utf8') });
    return true;
  }

  if (p === '/api/brain/needs' && req.method === 'GET') {
    const CS = require('./claim-sources');
    json(res, 200, { items: needsOpenItems().map((it) => ({ ...it, sources: it.id.startsWith('c-') ? CS.get(VAULT, it.id) : null })) });
    return true;
  }

  if (p === '/api/brain/needs/answer' && req.method === 'POST') {
    const body = (await readBody(req).catch(() => ({}))) || {};
    if (isRunning('resolve') || isRunning('verify')) return json(res, 409, { error: 'Resolve or Verify is running and may rewrite Needs-You.md; try again in a minute' }), true;
    try { answerNeed(String(body.id || ''), String(body.label || '')); } catch (e) { return json(res, 400, { error: e.message }), true; }
    json(res, 200, { items: needsOpenItems() });
    return true;
  }

  // --- Restructure compare (T24): built by code from the staged files.
  const rc = p.match(/^\/api\/brain\/restructure\/([\w.-]+)\/(compare|section|comment|restage)$/);
  if (rc) {
    const RC = require('./restructure-compare');
    const slug = rc[1];
    try {
      if (rc[2] === 'compare' && req.method === 'GET') return json(res, 200, RC.compare(VAULT, slug)), true;
      if (rc[2] === 'section' && req.method === 'GET') return json(res, 200, RC.section(VAULT, slug, url.searchParams.get('i'))), true;
      if (rc[2] === 'comment' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, { comments: RC.saveComment(VAULT, slug, b.head, b.text) }), true; }
      if (rc[2] === 'restage' && req.method === 'POST') {
        if (isRunning('restructure')) return json(res, 409, { error: 'Restructure is already running' }), true;
        const { rel } = RC.compare(VAULT, slug);
        let comments = {}; try { comments = JSON.parse(fs.readFileSync(path.join(VAULT, RESTRUCTURE_DIR, slug, 'comments.json'), 'utf8')); } catch {}
        fs.renameSync(path.join(VAULT, RESTRUCTURE_DIR, slug), path.join(VAULT, RESTRUCTURE_DIR, `${slug}-stale-${Date.now()}`));
        const bot = BOTS.find((b) => b.id === 'restructure');
        const run = newRun(bot);
        if (gated(run, 'restructure')) Promise.resolve(bot.run(run, claudeBin, { page: rel, comments })).catch((e) => failRun(run, e));
        return json(res, 200, { runId: run.id }), true;
      }
    } catch (e) { return json(res, 400, { error: e.message }), true; }
  }

  if (p === '/api/brain/restructure/apply' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (isRunning('restructure')) return json(res, 409, { error: 'Restructure is already running' }), true;
    try { tickRestructure(String((body || {}).slug || '')); } catch (e) { return json(res, 400, { error: e.message }), true; }
    const bot = BOTS.find((b) => b.id === 'restructure');
    const run = newRun(bot);
    Promise.resolve(bot.run(run, claudeBin, {})).catch((e) => failRun(run, e));
    json(res, 200, { runId: run.id });
    return true;
  }

  if (p === '/api/brain/runs' && req.method === 'GET') {
    const bot = url.searchParams.get('bot');
    const list = [...runs.values()].filter((r) => !bot || r.bot === bot).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    json(res, 200, list.slice(0, 20));
    return true;
  }

  json(res, 404, { error: 'unknown brain endpoint' });
  return true;
}

module.exports = { handle, start, VAULT, sessions: () => SESSIONS };
