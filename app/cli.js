#!/usr/bin/env node
// second-brain: the command line for the Second Brain app.
//
//   second-brain               start the app (if needed) and open its window
//   second-brain setup         create a vault and start the app at login
//   second-brain doctor        print what stops the bots, and the fixes
//   second-brain migrate       move an existing vault onto this kit (--write applies)
//   second-brain status        what runs, what waits on you (--json)
//   second-brain run <bot>     start a bot in the app (--wait for the result)
//   second-brain update        pull the kit, add new config keys, re-render the kit block
//
// setup options (each is asked for when missing and a terminal is attached):
//   --vault <dir>       the vault folder (required; there is no default)
//   --name <name>       your name, as people write it in Slack and docs
//   --email <email>     your work email (default: the claude.ai login)
//   --slack-user-id <U> your Slack member ID
//   --timezone <zone>   default: this Mac's zone
//   --port <n>          default 19300
//   --no-login-item     do not install the LaunchAgent
//   --no-obsidian       do not add the vault to Obsidian's vault list
//   --no-dock-app       do not make ~/Applications/Second Brain.app or add it to the Dock
//   --yes               accept defaults, ask nothing

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const KIT_DIR = path.resolve(__dirname, '..');
const install = require('./lib/install');

const out = (s = '') => process.stdout.write(`${s}\n`);
const fail = (s) => { process.stderr.write(`second-brain: ${s}\n`); process.exit(1); };

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    if (['yes', 'no-login-item', 'no-obsidian', 'no-dock-app', 'write', 'wait', 'json', 'post'].includes(k)) o[k] = true;
    else o[k] = v !== undefined ? v : argv[++i];
  }
  return o;
}

const tilde = (p) => (p ? path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir())) : p);
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const yq = (s) => JSON.stringify(String(s == null ? '' : s));

async function ask(rl, q, def) {
  if (!rl) return def;
  return new Promise((resolve) => rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => resolve(a.trim() || def || '')));
}

// --- prerequisites ---------------------------------------------------------------

function prerequisites() {
  const problems = [];
  if (process.platform !== 'darwin') problems.push('Second Brain runs on macOS only (it uses launchd and the macOS pty).');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) problems.push(`Node ${process.versions.node} is too old; install Node 18 or newer (\`brew install node\`, or https://nodejs.org).`);
  const claude = install.findClaude();
  let auth = null;
  if (!claude) problems.push('Claude Code is not installed. Run `npm install -g @anthropic-ai/claude-code` (or see https://claude.com/claude-code), run `claude` and log in with your claude.ai account, then run setup again.');
  else {
    auth = install.claudeAuth(claude);
    if (!auth || !auth.loggedIn) problems.push('Claude Code is not logged in. Run `claude`, log in with your claude.ai account, then run setup again.');
    else if (auth.authMethod && auth.authMethod !== 'claude.ai') problems.push(`Claude Code uses ${auth.authMethod}; the bots need a claude.ai login (they reach your sources through claude.ai connectors). Run \`claude auth login\` and pick your claude.ai account.`);
  }
  return { problems, claude, auth };
}

// --- vault -----------------------------------------------------------------------------

// The starter config: the schema with this person's values filled in.
function starterConfig({ name, email, slackUserId, timezone }) {
  let t = fs.readFileSync(path.join(KIT_DIR, 'config.example.yaml'), 'utf8');
  const set = (key, val) => { t = t.replace(new RegExp(`^(  ${key}: ).*$`, 'm'), `$1${yq(val)}`); };
  set('name', name || 'Your Name');
  set('email', email || 'you@example.com');
  set('slack_user_id', slackUserId || 'U000XXXXX');
  set('timezone', timezone);
  // The calendar allowlist starts as the owner's own work calendar.
  if (email) t = t.replace(/^(    calendars:\n      - )"you@example\.com"/m, `$1${yq(email)}`);
  return t;
}

// The vault skeleton: templates/vault holds only folder READMEs, .gitkeep
// files and the vault .gitignore. Only those kinds are copied, so a stray
// file that lands in the kit folder (an old sync, a test) can never reach a
// new vault. CLAUDE.md is rendered separately (lib/kit-block.js).
const SKELETON_FILES = new Set(['README.md', '.gitkeep', '.gitignore']);
function skeletonFiles(dir = path.join(KIT_DIR, 'templates', 'vault'), rel = '') {
  const out = [];
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, d.name);
    if (d.isDirectory()) out.push(...skeletonFiles(dir, r));
    else if (d.isFile() && SKELETON_FILES.has(d.name)) out.push(r);
  }
  return out;
}

function createVault(vault, answers) {
  const made = [];
  // The skeleton's READMEs and .gitkeep files go only into a NEW vault. An
  // existing vault is the owner's; setup then adds only what the bots need.
  const fresh = !fs.existsSync(path.join(vault, 'wiki'));
  fs.mkdirSync(vault, { recursive: true });
  const tmpl = path.join(KIT_DIR, 'templates', 'vault');
  for (const rel of fresh ? skeletonFiles() : []) {
    const to = path.join(vault, rel);
    if (fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(tmpl, rel), to, fs.constants.COPYFILE_EXCL);
    if (!rel.endsWith('.gitkeep')) made.push(rel);
  }
  const doctor = require('./lib/doctor');
  made.push(...doctor.repair(vault));
  const cfg = path.join(vault, 'config.yaml');
  if (!fs.existsSync(cfg)) { fs.writeFileSync(cfg, starterConfig(answers), { flag: 'wx' }); made.push('config.yaml'); }
  const kb = require('./lib/kit-block').update(vault, { write: true });
  if (kb.status === 'inserted' || kb.status === 'updated') made.push(`CLAUDE.md (kit block ${kb.status})`);
  else if (kb.status === 'edited-inside') out(`  ! CLAUDE.md: ${kb.reason}. The kit block was not changed.`);
  return made;
}

// --- login item ------------------------------------------------------------------------

function launchAgentPlist({ vault, port, node, claude }) {
  const paths = [path.dirname(node), claude ? path.dirname(claude) : null, path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const v = {
    LABEL: install.LABEL, NODE: node, SERVER: path.join(KIT_DIR, 'app', 'server.js'), APP_DIR: path.join(KIT_DIR, 'app'),
    LOG: path.join(install.STATE_DIR, 'server.log'), PATH: [...new Set(paths.filter(Boolean))].join(':'),
    VAULT: vault, PORT: String(port), HOME: os.homedir(),
  };
  return fs.readFileSync(path.join(KIT_DIR, 'launchd', 'second-brain.plist.tmpl'), 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in v ? xml(v[k]) : m));
}

function installLoginItem(plistText) {
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${install.LABEL}.plist`);
  fs.writeFileSync(file, plistText);
  if (process.env.SECOND_BRAIN_NO_LAUNCHCTL) return { file, loaded: false };
  const uid = process.getuid();
  for (const label of [install.LABEL, ...install.OLD_LABELS]) spawnSync('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
  const r = spawnSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, file], { encoding: 'utf8' });
  return { file, loaded: r.status === 0, error: r.stderr };
}

// The node the login item starts. Prefer the stable path the launcher found
// on PATH (/opt/homebrew/bin/node survives `brew upgrade`; the Cellar path it
// resolves to does not). Fall back to this process's real path (nvm, Volta).
function nodePath() {
  const viaLauncher = process.env.SECOND_BRAIN_NODE;
  if (viaLauncher && fs.existsSync(viaLauncher)) {
    try { if (fs.realpathSync(viaLauncher) === fs.realpathSync(process.execPath)) return viaLauncher; } catch {}
  }
  try { return fs.realpathSync(process.execPath); } catch { return process.execPath; }
}

// --- commands ----------------------------------------------------------------------------

async function setup(o) {
  out('Second Brain setup\n');
  const pre = prerequisites();
  if (pre.problems.length) { pre.problems.forEach((p) => out(`  ✗ ${p}`)); fail('fix the items above, then run setup again.'); }
  out(`  ✓ macOS, Node ${process.versions.node}, Claude Code logged in${pre.auth && pre.auth.email ? ` as ${pre.auth.email}` : ''}`);

  const rl = !o.yes && process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const current = install.resolveVault();
    const vault = tilde(o.vault || await ask(rl, '\nVault folder (your private notes; created if missing)', current || path.join(os.homedir(), 'SecondBrain')));
    if (!vault || (!o.vault && !rl && !current)) fail('pass --vault <dir> (there is no default vault).');
    if (vault.startsWith(KIT_DIR + path.sep) || vault === KIT_DIR) fail('the vault must not be inside the kit folder (the kit is public code).');
    const name = o.name || await ask(rl, 'Your name', (spawnSync('/usr/bin/id', ['-F'], { encoding: 'utf8' }).stdout || '').trim());
    const email = o.email || await ask(rl, 'Your work email', pre.auth && pre.auth.email);
    const slackUserId = o['slack-user-id'] || await ask(rl, 'Your Slack member ID (Slack profile → More → Copy member ID; blank = later)', '');
    const timezone = o.timezone || require('./lib/config').localZone();
    const port = Number(o.port || install.port());

    out(`\nCreating the vault in ${vault}`);
    const made = createVault(vault, { name, email, slackUserId, timezone });
    made.forEach((m) => out(`  + ${m}`));
    if (!made.length) out('  (everything was already there; nothing was changed)');

    const S = require('./lib/setup');
    if (!o['no-obsidian'] && S.obsidianInstalled()) {
      const ob = S.registerVault(vault);
      out(ob.registered ? `  ✓ Obsidian knows this vault${ob.added ? ' (added)' : ''}` : `  ! Obsidian: ${ob.why} Then press Apply on the Setup page (Obsidian step).`);
    }

    install.writeSettings({ vault, port, kit: KIT_DIR });
    out(`  ✓ settings: ${install.SETTINGS}`);

    if (!o['no-login-item']) {
      const li = installLoginItem(launchAgentPlist({ vault, port, node: nodePath(), claude: pre.claude }));
      out(`  ✓ login item: ${li.file}${li.loaded ? ' (started)' : process.env.SECOND_BRAIN_NO_LAUNCHCTL ? ' (not loaded: test mode)' : ` (NOT started: ${String(li.error || '').trim()})`}`);
    }

    if (!o['no-dock-app']) {
      const D = require('./lib/dock-app');
      try {
        D.write(KIT_DIR);
        const dock = D.addToDock();
        out(`  ✓ app: ${D.appPath()}${dock === 'added' ? ' (added to the Dock)' : dock === 'already' ? ' (in the Dock)' : ` (Dock ${dock})`}`);
      } catch (e) { out(`  ! app: ${e.message}. Open the app with ${path.join(KIT_DIR, 'app', 'bin', 'second-brain')}`); }
    }

    const doctor = require('./lib/doctor');
    const findings = doctor.check(vault, { claudeBin: pre.claude }).filter((f) => f.level !== 'info');
    out('\nChecks:');
    if (!findings.length) out('  ✓ nothing stops the bots');
    for (const f of findings) out(`  ${f.level === 'error' ? '✗' : '!'} ${f.message}${f.fix ? `\n      ${f.fix}` : ''}`);
    out(`\nNext: open http://localhost:${port} and finish the Setup page (connectors, scope, privacy, first run).`);
  } finally { if (rl) rl.close(); }
}

function doctorCmd() {
  const vault = install.resolveVault();
  if (!vault) fail('not set up: run `second-brain setup`.');
  const findings = require('./lib/doctor').check(vault, { claudeBin: install.findClaude() }).filter((f) => f.level !== 'info');
  if (!findings.length) { out('Nothing stops the bots.'); return; }
  for (const f of findings) out(`${f.level.toUpperCase().padEnd(5)} ${f.message}${f.fix ? `\n      ${f.fix}` : ''}`);
  if (findings.some((f) => f.level === 'error')) process.exitCode = 1;
}

// --- migrate (an existing vault onto the kit layout, decision 6A) -------------------

const OWNER_HEADER = `<!-- ======================================================================
  THIS VAULT'S OWN NOTES (kept from the CLAUDE.md before the kit block).
  The kit block above is the current spec. The text below is this vault's
  earlier copy: its specifics (scope IDs, calendar names, measured incidents)
  still hold where the block does not cover them. Where the two disagree,
  the block wins. The app never changes anything below this line.
====================================================================== -->`;

// Running = the app holds a fresh .bot/lock (heartbeat < 15 min) that lists
// the Morning run. A run that crashed never wrote endedAt, so schedule.json
// alone would block update and migrate until the next good run.
function morningRunning(vault) {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(vault, '.bot', 'lock'), 'utf8'));
    return Date.now() - Date.parse(l.heartbeat) < 15 * 60000 && (l.running || []).includes('morning');
  } catch { return false; }
}

function migratePlan(vault, { email }) {
  const steps = [];
  const C = require('./lib/config');
  const cfgFile = path.join(vault, 'config.yaml');
  const old = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
  if (old) {
    let r = C.convertLegacy(old);
    let text = r.text;
    const yaml = require('./lib/vendor/js-yaml');
    const y = yaml.load(text);
    // Fill what conversion cannot know: the Linear scope (from the cache)
    // and the owner's email (from the claude.ai login). Text edits only.
    let cache = null; try { cache = JSON.parse(fs.readFileSync(path.join(vault, 'linear', '.initiative-scope.json'), 'utf8')); } catch {}
    const sc = (y.sources && y.sources.linear && y.sources.linear.scope) || {};
    if (!sc.initiative && !sc.team && cache && (cache.root_id || cache.team)) {
      text = text.replace(/^(    scope:\n      initiative: )""\n(      team: )""$/m, cache.root_id ? `$1${JSON.stringify(cache.root_id)}\n$2""` : `$1""\n$2${JSON.stringify(cache.team)}`);
    }
    if (email && !(y.owner && y.owner.email)) text = text.replace(/^(  email: )""$/m, `$1${JSON.stringify(email)}`);
    if (text !== old) steps.push({ id: 'config', title: `config.yaml → version 2${r.moves && r.moves.length ? ` (${r.moves.join('; ')})` : ''}, +${r.added.length} default key(s)`, diff: require('./lib/kit-block').lineDiff(old, text), apply: () => fs.writeFileSync(cfgFile, text) });
  }
  const KB = require('./lib/kit-block');
  // Render from the config as it WILL be, so the block shows the new values.
  const kbPreview = () => { const r = KB.update(vault, { ownerHeader: OWNER_HEADER }); return r; };
  steps.push({ id: 'claude-md', title: 'CLAUDE.md: kit block on top; the existing text kept below, unchanged', lazy: true, preview: kbPreview, apply: () => { const r = KB.update(vault, { write: true, ownerHeader: OWNER_HEADER }); if (r.status === 'edited-inside') throw new Error(`CLAUDE.md: ${r.reason}`); return r.status; } });
  steps.push({ id: 'settings', title: `${install.SETTINGS}: vault ${vault}, kit ${KIT_DIR}`, apply: () => install.writeSettings({ vault, port: install.port(), kit: KIT_DIR }) });
  const audits = path.join(vault, 'docs', 'audits');
  if (fs.existsSync(audits)) {
    steps.push({ id: 'wrappers', title: `docs/audits/*.sh: thin wrappers that run ${KIT_DIR}/scripts`, apply: () => {
      for (const n of ['delta-walk', 'linkrot-lint', 'bind-project-memory', 'refresh-project-symlinks']) {
        fs.writeFileSync(path.join(audits, `${n}.sh`), `#!/usr/bin/env bash\n# Thin wrapper (second-brain migrate): the real script lives in the kit,\n# so every vault runs the same copy.\nKIT="\${SECOND_BRAIN_KIT:-${KIT_DIR}}"\nexec bash "$KIT/scripts/${n}.sh" --vault "$(cd "$(dirname "$0")/../.." && pwd)" "$@"\n`, { mode: 0o755 });
      }
      fs.writeFileSync(path.join(audits, 'raw-classes.sh'), `#!/usr/bin/env bash\n# Thin wrapper (second-brain migrate): the class list lives in the kit.\n. "\${SECOND_BRAIN_KIT:-${KIT_DIR}}/scripts/raw-classes.sh"\n`, { mode: 0o755 });
    } });
  }
  steps.push({ id: 'login-item', title: `login item: ${install.LABEL} (runs ${KIT_DIR}); removes ${install.OLD_LABELS.join(', ')}`, apply: () => {
    const li = installLoginItem(launchAgentPlist({ vault, port: install.port(), node: nodePath(), claude: install.findClaude() }));
    for (const l of install.OLD_LABELS) { const f = path.join(os.homedir(), 'Library', 'LaunchAgents', `${l}.plist`); if (fs.existsSync(f)) fs.rmSync(f); }
    if (!li.loaded && !process.env.SECOND_BRAIN_NO_LAUNCHCTL) throw new Error(`login item did not start: ${li.error}`);
  } });
  return steps;
}

async function migrate(o) {
  const vault = tilde(o.vault || install.resolveVault());
  if (!vault || !fs.existsSync(path.join(vault, 'wiki'))) fail('pass --vault <dir> (an existing vault with a wiki/ folder).');
  if (morningRunning(vault)) fail('a Morning run is in progress; run migrate after it ends.');
  const pre = prerequisites();
  if (pre.problems.length) { pre.problems.forEach((p) => out(`  ✗ ${p}`)); fail('fix the items above first.'); }
  const steps = migratePlan(vault, { email: pre.auth && pre.auth.email });
  out(`Migrate ${vault} onto the kit at ${KIT_DIR}${o.write ? '' : '   (DRY RUN: nothing changes; add --write)'}\n`);
  for (const s of steps) {
    out(`• ${s.title}`);
    if (s.diff && o.diff !== 'off') out(s.diff.split('\n').slice(0, Number(o['diff-lines'] || 60)).map((l) => `    ${l}`).join('\n'));
  }
  if (!o.write) { out('\nRun again with --write to apply. A backup is made first.'); return; }

  // Backup first: everything migrate can touch, plus the delta counts before.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bdir = path.join(install.STATE_DIR, 'backups', `migrate-${stamp}`);
  fs.mkdirSync(bdir, { recursive: true });
  const items = ['config.yaml', 'CLAUDE.md', 'docs/audits', '.bot/state', 'linear/.initiative-scope.json'].filter((p) => fs.existsSync(path.join(vault, p)));
  const tar = spawnSync('/usr/bin/tar', ['-czf', path.join(bdir, 'vault-files.tgz'), '-C', vault, ...items], { encoding: 'utf8' });
  if (tar.status !== 0) fail(`backup failed: ${tar.stderr}`);
  for (const l of [install.LABEL, ...install.OLD_LABELS]) { const f = path.join(os.homedir(), 'Library', 'LaunchAgents', `${l}.plist`); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(bdir, `${l}.plist`)); }
  const dw = await require('./lib/ingest').deltaWalk(vault);
  fs.writeFileSync(path.join(bdir, 'deltas-before.txt'), `${dw.deltasLine}\nfiles: ${dw.files.length}\n`);
  out(`\n  ✓ backup: ${bdir}`);
  for (const s of steps) { const r = s.apply(); out(`  ✓ ${s.id}${typeof r === 'string' ? ` (${r})` : ''}`); }
  const findings = require('./lib/doctor').check(vault, { claudeBin: pre.claude }).filter((f) => f.level !== 'info');
  out('\nChecks:');
  if (!findings.length) out('  ✓ nothing stops the bots');
  for (const f of findings) out(`  ${f.level === 'error' ? '✗' : '!'} ${f.message}`);
  out(`\nGate: two clean Morning runs whose "Deltas walked" counts match the pattern in ${path.join(bdir, 'deltas-before.txt')}.`);
  out(`Undo: tar -xzf ${path.join(bdir, 'vault-files.tgz')} -C ${vault}  (and restore the plist from the same folder).`);
}

// --- status / run: a remote control for the running app (A4) ----------------------
// Chat sessions (Claude Code, Cowork) use these instead of running app-owned
// jobs themselves. There is deliberately NO `answer` command (OV-a): Needs-You
// answers are written only by a click in the app, so instructions hidden in
// synced text cannot tick an answer.
async function appApi(p, opt = {}) {
  const port = install.port();
  let token = '';
  try { token = fs.readFileSync(path.join(install.STATE_DIR, 'token'), 'utf8').trim(); } catch { fail('the app has never run here (no token). Start it: second-brain'); }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${p}`, { ...opt, headers: { 'Content-Type': 'application/json', 'X-Brain-Token': token, Origin: `http://localhost:${port}` } });
  } catch { fail(`the app is not running on port ${port}. Start it: second-brain`); }
  const text = await res.text();
  let body = {}; try { body = JSON.parse(text); } catch {}
  if (res.status === 401 || res.status === 403) fail(`the app refused the request (${text.trim() || res.status}). The token in ${install.STATE_DIR}/token does not match the running app: restart it (second-brain).`);
  if (!res.ok) fail(body.error || `the app answered ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

const ago = (iso) => { if (!iso) return 'never'; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };

async function statusCmd(o) {
  const j = await appApi('/api/brain/bots');
  if (o.json) { out(JSON.stringify({ schedule: j.schedule, setup: j.setup, bots: j.bots.map((b) => ({ id: b.id, status: b.last ? b.last.status : 'never', summary: b.last ? b.last.summary : '', ended: b.last ? b.last.endedAt : null, waiting: b.todo ? b.todo.text : null })) }, null, 2)); return; }
  out(`Morning run: ${j.schedule.enabled ? `${j.schedule.morningAt}, next ${j.schedule.next}` : 'off'}`);
  const running = j.bots.filter((b) => b.last && b.last.status === 'running');
  out(`Running now: ${running.length ? running.map((b) => b.id).join(', ') : 'nothing'}`);
  const waiting = j.bots.filter((b) => b.todo);
  out(`Waiting on the owner: ${waiting.length ? '' : 'nothing'}`);
  for (const b of waiting) out(`  - ${b.name}: ${b.todo.text}`);
  for (const f of j.setup.filter((x) => x.level === 'error')) out(`  - Setup: ${f.message}`);
  out('\nBots:');
  for (const b of j.bots) out(`  ${b.id.padEnd(14)} ${(b.last ? b.last.status : 'never').padEnd(8)} ${b.last ? `${ago(b.last.endedAt || b.last.startedAt).padEnd(9)} ${String(b.last.summary || '').slice(0, 90)}` : ''}`);
}

async function runCmd(o) {
  const id = o._[1];
  if (!id) fail('which bot? e.g. second-brain run sync-slack  (see: second-brain status)');
  if (!/^[a-z-]+$/.test(id)) fail(`bad bot name "${id}"`);
  const r = await appApi(`/api/brain/bots/${id}/run`, { method: 'POST', body: '{}' });
  out(`started ${id} (run ${r.runId}). Follow it in the app's Log${o.wait ? '; waiting…' : ', or add --wait'}.`);
  if (!o.wait) return;
  for (;;) {
    await new Promise((res) => setTimeout(res, 5000));
    const b = (await appApi('/api/brain/bots')).bots.find((x) => x.id === id);
    if (b && b.last && b.last.id === r.runId && b.last.status !== 'running') { out(`${b.last.status}: ${b.last.summary}`); if (b.last.status === 'error') process.exitCode = 1; return; }
  }
}

// --- update (5A): pull the kit, then migrate config + re-render the kit block -------
const git = (...a) => spawnSync('/usr/bin/git', ['-C', KIT_DIR, ...a], { encoding: 'utf8' });

function kitBehind({ fetch = true } = {}) {
  if (git('rev-parse', '--git-dir').status !== 0) return { error: `${KIT_DIR} is not a git checkout; reinstall from the repo` };
  if (fetch) { const f = git('fetch', '--quiet'); if (f.status !== 0) return { error: `git fetch failed: ${(f.stderr || '').trim().split('\n')[0]}` }; }
  const up = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  if (up.status !== 0) return { error: 'this checkout tracks no upstream branch' };
  const n = Number(git('rev-list', '--count', 'HEAD..@{u}').stdout.trim() || 0);
  const log = n ? git('log', '--oneline', '--no-decorate', 'HEAD..@{u}').stdout.trim().split('\n') : [];
  return { behind: n, upstream: up.stdout.trim(), log };
}

// After the pull, in the NEW code: config gets new keys (never a changed
// value), the kit block is re-rendered (an edit inside it stops that part).
function postUpdate(vault, write) {
  const C = require('./lib/config');
  const KB = require('./lib/kit-block');
  const steps = [];
  const cfgFile = path.join(vault, 'config.yaml');
  if (fs.existsSync(cfgFile)) {
    const old = fs.readFileSync(cfgFile, 'utf8');
    const res = (Number((require('./lib/vendor/js-yaml').load(old) || {}).config_version || 1) < C.CONFIG_VERSION ? C.convertLegacy : C.migrateConfig)(old);
    if (res.text !== old) { steps.push(`config.yaml: +${res.added.length} key(s)${res.added.length ? ` (${res.added.slice(0, 6).join(', ')}${res.added.length > 6 ? ', …' : ''})` : ''}`); if (write) fs.writeFileSync(cfgFile, res.text); }
  }
  const kb = KB.update(vault, { write });
  if (kb.status === 'edited-inside') steps.push(`CLAUDE.md: NOT updated: ${kb.reason}`);
  else if (kb.status !== 'unchanged') steps.push(`CLAUDE.md: kit block ${kb.status} (${kb.diff.split('\n').filter(Boolean).length} line(s) differ)`);
  // The Dock app runs this kit's launcher: rewrite it so it follows the kit.
  // An update never touches the Dock itself; setup adds it once.
  const D = require('./lib/dock-app');
  if (!fs.existsSync(D.appPath())) steps.push(`app: ${D.appPath()} (new; drag it to the Dock)`);
  if (write) { try { D.write(KIT_DIR); } catch (e) { steps.push(`app: NOT written: ${e.message}`); } }
  return { steps, kitBlock: kb.status };
}

async function update(o) {
  const vault = install.resolveVault();
  if (!vault) fail('not set up: run `second-brain setup`.');
  if (o.post) { const r = postUpdate(vault, !!o.write); r.steps.forEach((x) => out(`  • ${x}`)); if (!r.steps.length) out('  • config.yaml and the kit block are current'); return; }
  if (morningRunning(vault)) fail('a Morning run is in progress; update after it ends.');
  const dirty = git('status', '--porcelain', '--untracked-files=no').stdout.trim();
  if (dirty) fail(`the kit checkout ${KIT_DIR} has local edits; update refuses to touch it:\n${dirty}`);
  const b = kitBehind();
  if (b.error) fail(b.error);
  out(b.behind ? `${b.behind} new commit(s) on ${b.upstream}:\n${b.log.map((l) => `  ${l}`).join('\n')}` : `The kit is up to date (${b.upstream}).`);
  if (!o.yes && process.stdin.isTTY && b.behind) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await ask(rl, 'Update now? (y/N)', 'n'); rl.close();
    if (!/^y/i.test(a)) { out('Nothing changed.'); return; }
  }
  if (b.behind) {
    const p = git('merge', '--ff-only', '--quiet', '@{u}');
    if (p.status !== 0) fail(`the update could not fast-forward; nothing changed: ${(p.stderr || '').trim()}`);
    out(`  ✓ kit updated to ${git('rev-parse', '--short', 'HEAD').stdout.trim()}`);
  }
  // The new code does the vault part.
  const post = spawnSync(process.execPath, [path.join(KIT_DIR, 'app', 'cli.js'), 'update', '--post', '--write'], { encoding: 'utf8', env: process.env });
  process.stdout.write(post.stdout); process.stderr.write(post.stderr);
  if (!process.env.SECOND_BRAIN_NO_LAUNCHCTL && b.behind) {
    spawnSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${install.LABEL}`], { stdio: 'ignore' });
    out('  ✓ the app restarted on the new code');
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0] || 'open';
  if (cmd === 'setup') return setup(o);
  if (cmd === 'doctor') return doctorCmd();
  if (cmd === 'migrate') return migrate(o);
  if (cmd === 'status') return statusCmd(o);
  if (cmd === 'update') return update(o);
  if (cmd === 'run') return runCmd(o);
  if (cmd === 'help' || cmd === '--help') { out(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 21).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  fail(`unknown command "${cmd}". Try: second-brain help`);
}

if (require.main === module) main().catch((e) => fail(e.message));

module.exports = { kitBehind, postUpdate, parseArgs, starterConfig, createVault, launchAgentPlist, prerequisites, skeletonFiles, migratePlan, OWNER_HEADER };
