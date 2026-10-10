#!/usr/bin/env node
// second-brain: the command line for the Second Brain app.
//
//   second-brain               start the app (if needed) and open its window
//   second-brain setup         create a vault and start the app at login
//   second-brain doctor        print what stops the bots, and the fixes
//   second-brain migrate       move an existing vault onto this kit (--write applies)
//
// setup options (each is asked for when missing and a terminal is attached):
//   --vault <dir>       the vault folder (required; there is no default)
//   --name <name>       your name, as people write it in Slack and docs
//   --email <email>     your work email (default: the claude.ai login)
//   --slack-user-id <U> your Slack member ID
//   --timezone <zone>   default: this Mac's zone
//   --port <n>          default 19300
//   --no-login-item     do not install the LaunchAgent
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
    if (['yes', 'no-login-item', 'write'].includes(k)) o[k] = true;
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
  if (major < 18) problems.push(`Node ${process.versions.node} is too old; install Node 18 or newer.`);
  const claude = install.findClaude();
  let auth = null;
  if (!claude) problems.push('Claude Code is not installed. Install it from https://claude.com/claude-code, log in, then run setup again.');
  else {
    auth = install.claudeAuth(claude);
    if (!auth || !auth.loggedIn) problems.push('Claude Code is not logged in. Run `claude`, log in with your claude.ai account, then run setup again.');
    else if (auth.authMethod && auth.authMethod !== 'claude.ai') problems.push(`Claude Code uses ${auth.authMethod}; the bots need a claude.ai login (they reach your sources through claude.ai connectors).`);
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

    install.writeSettings({ vault, port, kit: KIT_DIR });
    out(`  ✓ settings: ${install.SETTINGS}`);

    if (!o['no-login-item']) {
      const li = installLoginItem(launchAgentPlist({ vault, port, node: nodePath(), claude: pre.claude }));
      out(`  ✓ login item: ${li.file}${li.loaded ? ' (started)' : process.env.SECOND_BRAIN_NO_LAUNCHCTL ? ' (not loaded: test mode)' : ` (NOT started: ${String(li.error || '').trim()})`}`);
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

function morningRunning(vault) {
  try { const s = JSON.parse(fs.readFileSync(path.join(vault, '.bot', 'state', 'schedule.json'), 'utf8')); return s.startedAt && (!s.endedAt || s.endedAt < s.startedAt); } catch { return false; }
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

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0] || 'open';
  if (cmd === 'setup') return setup(o);
  if (cmd === 'doctor') return doctorCmd();
  if (cmd === 'migrate') return migrate(o);
  if (cmd === 'help' || cmd === '--help') { out(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  fail(`unknown command "${cmd}". Try: second-brain help`);
}

if (require.main === module) main().catch((e) => fail(e.message));

module.exports = { parseArgs, starterConfig, createVault, launchAgentPlist, prerequisites, skeletonFiles, migratePlan, OWNER_HEADER };
