// The doctor: is this install able to run its bots? Pure checks, no model
// calls ($0). Runs at server start and before every bot; an error that names
// a bot blocks that bot and shows under Your move with its fix.
//
//   check(vault, { claudeBin })   -> [{ level, key, message, fix, bots, repair }]
//   blockers(findings, botId)     -> the errors that stop botId
//   repair(vault)                 -> creates ONLY what is missing; never overwrites
//
// level: error (the named bots cannot run) | warn (they run; something is off)
// bots:  ['*'] = every bot, or a list of bot ids
// repair: true when repair() can fix it (a missing folder or starter file)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getConfig, validate } = require('./config');
const { KIT_DIR, script } = require('./kit');
const { SOURCES } = require('./sync');

// Claude Code versions the kit was tested with. Others run, with a warning.
const KNOWN_GOOD = ['2.1.296'];
// Every flag the bots pass (lib/claude-call.js, the chat).
const FLAGS = ['-p', '--model', '--resume', '--output-format', '--verbose', '--tools', '--allowedTools', '--disallowedTools',
  '--permission-prompts', '--setting-sources', '--settings', '--strict-mcp-config', '--mcp-config', '--max-budget-usd',
  '--no-session-persistence', '--add-dir', '--append-system-prompt', '--session-id'];

const MODEL_BOTS = ['ingest', 'verify', 'brief', 'resolve', 'restructure'];
const SCRIPTS = { 'delta-walk.sh': ['ingest', 'deltas', 'morning'], 'linkrot-lint.sh': ['verify', 'lint'], 'bind-project-memory.sh': ['verify'], 'raw-classes.sh': ['ingest', 'deltas', 'lint', 'verify', 'morning'] };

// The vault layout every bot expects. Raw dirs come from the sync sources.
const RAW_DIRS = ['projects', 'slack', 'gcal', 'gdrive/files', 'notion/pages', 'notion/databases', 'linear/issues', 'linear/projects', 'linear/initiatives', 'linear/docs'];
const STARTERS = { 'wiki/index.md': 'index.template.md', 'wiki/log.md': 'log.template.md' };

const claudeCache = new Map(); // bin + mtime -> { version, missingFlags }

function claudeFacts(bin) {
  let st; try { st = fs.statSync(bin); } catch { return null; }
  const key = `${bin}:${st.mtimeMs}`;
  if (claudeCache.has(key)) return claudeCache.get(key);
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
  const v = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000, env });
  const h = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 15000, env });
  const version = ((v.stdout || '').match(/(\d+\.\d+\.\d+)/) || [])[1] || '';
  const help = `${h.stdout || ''}${h.stderr || ''}`;
  const missingFlags = help ? FLAGS.filter((f) => !new RegExp(`(^|[\\s,])${f.replace(/-/g, '\\-')}([\\s,<]|$)`, 'm').test(help)) : FLAGS;
  const facts = { version, missingFlags };
  claudeCache.set(key, facts);
  return facts;
}

const authCache = new Map(); // bin -> { at, facts }; login can change, so 10 min
function authFacts(bin) {
  const hit = authCache.get(bin);
  if (hit && Date.now() - hit.at < 600000) return hit.facts;
  const facts = require('./install').claudeAuth(bin);
  authCache.set(bin, { at: Date.now(), facts });
  return facts;
}

let ptyCache = null;
// /usr/bin/python3 is a shim on every Mac; without the developer tools it
// opens Apple's install dialog. So check for the tools first and never trigger
// the dialog from a server start.
function ptyFacts() {
  if (ptyCache) return ptyCache;
  const clt = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', timeout: 5000 });
  if (clt.status !== 0) return (ptyCache = { ok: false, why: 'the Command Line Tools are not installed' });
  const r = spawnSync('/usr/bin/python3', ['-c', 'import pty'], { encoding: 'utf8', timeout: 10000 });
  return (ptyCache = r.status === 0 ? { ok: true } : { ok: false, why: (r.stderr || r.error || 'python3 failed').toString().split('\n')[0] });
}

// The LaunchAgent's node, if one is installed (OV9).
function launchAgentNode() {
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  for (const label of ['dev.secondbrain.app', 'com.remote.second-brain']) {
    const f = path.join(dir, `${label}.plist`);
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const args = (text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/) || [])[1] || '';
    const first = (args.match(/<string>([^<]+)<\/string>/) || [])[1] || '';
    return { label, plist: f, node: first };
  }
  return null;
}

function check(vault, { claudeBin } = {}) {
  const out = [];
  const add = (level, key, message, fix, bots = ['*'], extra = {}) => out.push({ level, key, message, fix, bots, ...extra });

  // 1. config.yaml
  for (const f of validate(vault)) {
    const bots = /^sources\.(\w+)/.test(f.key) ? [`sync-${f.key.split('.')[1]}`]
      : f.key === 'owner.slack_user_id' ? ['sync-slack']
        : f.key.startsWith('schedule.') ? ['morning'] : f.key === 'config.yaml' ? ['*'] : (f.level === 'error' ? ['*'] : []);
    const fix = f.key === 'config.yaml' ? 'Run Setup, or copy config.example.yaml to config.yaml in the vault.'
      : f.key === 'config_version' ? '`second-brain update` converts it and keeps your comments.'
        : `Edit ${f.key} in config.yaml.`;
    add(f.level, `config:${f.key}`, f.message, fix, bots);
  }
  const cfg = getConfig(vault);

  // 2. vault layout
  if (!fs.existsSync(vault)) { add('error', 'vault', `The vault folder ${vault} does not exist.`, 'Run Setup to create it.'); return out; }
  for (const d of ['wiki', ...RAW_DIRS, '.bot']) {
    if (!fs.existsSync(path.join(vault, d))) add('error', `dir:${d}`, `The vault has no ${d}/ folder.`, 'Press Repair to create the missing folders.', d === 'wiki' ? ['*'] : d.startsWith('.bot') ? ['*'] : [`sync-${d.split('/')[0]}`, 'ingest'], { repair: true });
  }
  for (const rel of Object.keys(STARTERS)) {
    if (!fs.existsSync(path.join(vault, rel))) add('error', `file:${rel}`, `The vault has no ${rel}.`, 'Press Repair to create an empty one from the kit template.', [...MODEL_BOTS, 'morning'], { repair: true });
  }
  if (!fs.existsSync(path.join(vault, 'CLAUDE.md'))) add('error', 'file:CLAUDE.md', 'The vault has no CLAUDE.md, so the bots have no op specs.', 'Run Setup (it writes the kit block into CLAUDE.md).', ['ingest', 'morning']);

  // 3. kit scripts
  for (const [name, bots] of Object.entries(SCRIPTS)) {
    if (!fs.existsSync(script(name))) add('error', `script:${name}`, `The kit is missing scripts/${name}.`, `Update the kit (git pull in ${KIT_DIR}).`, bots);
  }

  // 4. claude
  if (!claudeBin) add('error', 'claude', 'Claude Code (the claude command) was not found.', 'Install Claude Code, log in to claude.ai, then restart the app.');
  else {
    const f = claudeFacts(claudeBin);
    if (!f) add('error', 'claude', `claude at ${claudeBin} cannot be read.`, 'Reinstall Claude Code, then restart the app.');
    else {
      if (f.missingFlags.length) add('error', 'claude:flags', `This claude (${f.version || 'unknown version'}) has no ${f.missingFlags.join(', ')} flag(s) the bots need.`, 'Update Claude Code (claude update), then restart the app.');
      const auth = authFacts(claudeBin);
      if (auth && !auth.loggedIn) add('error', 'claude:login', 'Claude Code is not logged in.', 'Run `claude` in Terminal and log in with your claude.ai account, then restart the app.');
      else if (auth && auth.authMethod && auth.authMethod !== 'claude.ai') add('error', 'claude:login', `Claude Code is logged in with ${auth.authMethod}, not a claude.ai account. The bots reach your sources through claude.ai connectors.`, 'Run `claude auth login` and choose your claude.ai account.');
      if (f.version && !KNOWN_GOOD.includes(f.version)) add('warn', 'claude:version', `Claude Code ${f.version} is not on the kit's tested list (${KNOWN_GOOD.join(', ')}).`, 'It usually works. If a bot fails oddly, tell the kit maintainer the version.', []);
    }
  }

  // 5. the LaunchAgent's node (a moved or upgraded node stops the app at login)
  const la = launchAgentNode();
  if (la && (!la.node || !fs.existsSync(la.node))) add('error', 'launchagent:node', `The login item ${la.label} starts node at ${la.node || '(none)'}, which does not exist.`, 'Run `second-brain setup` again to rewrite the login item with the current node.', []);

  // 6. python pty, for app sessions (Phase 2): a warning until sessions ship.
  const pty = ptyFacts();
  if (!pty.ok) add('warn', 'python:pty', `Sessions need python3 with pty: ${pty.why}.`, 'Run `xcode-select --install` in Terminal, then restart the app.', []);

  // 6b. transcript retention: Claude Code's default deletes a project's
  // transcripts (and, before the vault held them, its memories) after 30 days.
  const ret = require('./retention').check();
  if (!ret.ok) add('warn', 'claude:retention', ret.error ? `Cannot read ${ret.file}: ${ret.error}` : `Claude Code deletes transcripts after ${ret.days || 30} days (cleanupPeriodDays in ${ret.file}). Old sessions and their memories can vanish, and wiki links to them go dead.`,
    ret.error ? 'Fix the JSON in that file, then press Repair.' : `Press Repair to set cleanupPeriodDays to ${require('./retention').KEEP_DAYS} (keeps them).`, [], { repair: !ret.error });

  // 7. per-source state
  const src = cfg.sources;
  if (src.linear.enabled && !fs.existsSync(path.join(vault, 'linear', '.initiative-scope.json'))) {
    add('error', 'linear:scope', 'Linear has no scope yet (linear/.initiative-scope.json).', 'Run Rescope on the Linear page.', ['sync-linear']);
  }
  if (src.notion.enabled && !getConfig(vault).owner.notion_user_id && !fs.existsSync(path.join(vault, 'notion', '.user-id'))) {
    add('error', 'owner.notion_user_id', 'Notion sync needs your Notion user ID.', 'Set owner.notion_user_id in config.yaml (Setup finds it for you).', ['sync-notion']);
  }
  for (const k of Object.keys(SOURCES)) {
    if (src[k] && src[k].enabled === false) add('info', `source:${k}`, `${SOURCES[k].name} is turned off in config.yaml.`, '', [`sync-${k}`], { off: true });
  }
  return out;
}

// The errors that stop one bot. Morning is stopped only by what stops all.
function blockers(findings, botId) {
  return findings.filter((f) => f.level === 'error' && (f.bots.includes('*') || f.bots.includes(botId)));
}

// Create what is missing, from the kit's templates. Never overwrites: every
// write uses the 'wx' flag, so an existing file is left exactly as it is.
// opts.retention: also set Claude Code's cleanupPeriodDays (a Mac-wide
// setting, so only the app's Repair button asks for it; tests do not).
function repair(vault, opts = {}) {
  const made = [];
  if (opts.retention) { try { if (require('./retention').ensure() === 'set') made.push('cleanupPeriodDays in ~/.claude/settings.json'); } catch {} }
  for (const d of ['wiki', ...RAW_DIRS, '.bot', '.bot/runs', '.bot/state']) {
    const p = path.join(vault, d);
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); made.push(`${d}/`); }
  }
  for (const [rel, tmpl] of Object.entries(STARTERS)) {
    const p = path.join(vault, rel);
    if (fs.existsSync(p)) continue;
    let body = '';
    try { body = fs.readFileSync(path.join(KIT_DIR, 'templates', tmpl), 'utf8'); } catch {}
    try { fs.writeFileSync(p, body, { flag: 'wx' }); made.push(rel); } catch {}
  }
  return made;
}

module.exports = { check, blockers, repair, KNOWN_GOOD, FLAGS, claudeFacts };
