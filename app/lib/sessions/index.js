// Sessions: real, interactive Claude Code in a pty, inside the app (A1, T19).
// The Thread engine is copied from briefcase@070851e (server.js Thread class +
// native-host/pty-wrapper.py), cut down and changed where the plan says:
//
//   - The app makes the session id and starts `claude --session-id <uuid>`
//     (OV-b). It never guesses an id from the newest transcript file.
//   - Sessions run in the vault with the person's OWN settings (A3: a human
//     is watching), plus the kit's deny rules: no writes to raw folders or
//     watermark files, by tool and by Bash pattern (OV-c, best effort).
//   - At most sessions.max_running at once; a new one puts the oldest idle one
//     to sleep. sessions.idle_sleep_min with no input also sleeps it (P1).
//     Asleep = process stopped, id kept; open again = `claude --resume <id>`.
//   - Done (an outcome button, or Close): the transcript is copied to
//     .bot/sessions/<id>.jsonl and kept sessions.keep_days days.
//
// Lifecycle:   open ──idle/evicted──▶ asleep ──open──▶ open ──outcome/close──▶ done

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { getConfig } = require('../config');
const { botEnv } = require('../claude-call');

const PTY_WRAPPER = path.join(__dirname, 'pty-wrapper.py');
const PYTHON = '/usr/bin/python3';
const MAX_REPLAY = 512 * 1024, REPLAY_SLACK = 64 * 1024;
const WORKING_MS = 1500;
const SIGNAL_READY_MS = 1500;
const RAW = ['projects', 'slack', 'linear', 'notion', 'gdrive', 'gmail', 'gcal'];
const WATERMARKS = ['wiki/.last-ingest', '*/.last-sync', '.bot/state/**'];
// A permission prompt drawn on the last screen ("Do you want to …?").
const PROMPT_RE = /Do you want to (proceed|make this edit|create|run)|❯ 1\. Yes/;
const OSC_ANY_RE = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

// The kit's deny rules for interactive sessions, written next to the app's
// state. Read with the person's own settings, so their hooks and allows apply.
function sessionSettings(stateDir) {
  const deny = [];
  // Edit(path) covers every file-editing tool (Write and Edit alike); a
  // Write(path) rule is not matched by file checks (Claude Code says so).
  for (const d of RAW) deny.push(`Edit(${d}/**)`, `Bash(rm ${d}/*)`, `Bash(mv ${d}/*)`, `Bash(* > ${d}/*)`, `Bash(* >> ${d}/*)`, `Bash(sed -i* ${d}/*)`);
  for (const w of WATERMARKS) deny.push(`Edit(${w})`);
  // Answers, the app's own state and the config are the app's to write: a
  // session gets synced text, so it must not tick an answer or change them.
  deny.push('Edit(Needs-You.md)', 'Edit(.bot/**)', 'Edit(config.yaml)', 'Bash(* > Needs-You.md)', 'Bash(* >> Needs-You.md)', 'Bash(sed -i* Needs-You.md)');
  const f = path.join(stateDir, 'session-settings.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ $comment: 'Written by the Second Brain app for its interactive sessions: the kit denies writes to raw folders and watermark files. Your own settings still apply.', permissions: { deny } }, null, 2));
  return f;
}

class Session {
  constructor(mgr, rec) {
    this.mgr = mgr;
    Object.assign(this, {
      id: rec.id, sessionId: rec.sessionId, title: rec.title, kind: rec.kind || 'chat', item: rec.item || null,
      model: rec.model || 'sonnet', prompt: rec.prompt || '', outcomes: rec.outcomes || [], suggest: rec.suggest || null,
      state: rec.state || 'asleep', createdAt: rec.createdAt || Date.now(), lastInput: rec.lastInput || Date.now(),
      endedAt: rec.endedAt || null, outcome: rec.outcome || null, started: !!rec.started,
    });
    this.pty = null;
    this.clients = new Set();
    this.replay = '';
    this.bell = false;
    this.lastOut = 0;
    this.controlFile = path.join(os.tmpdir(), `second-brain-pty-${this.id}`);
  }

  get running() { return this.pty !== null; }
  get activity() {
    if (!this.pty) return this.state;
    if (this.bell || PROMPT_RE.test(this.replay.slice(-2048))) return 'attention';
    return Date.now() - this.lastOut < WORKING_MS ? 'working' : 'idle';
  }

  start(cols = 100, rows = 30) {
    if (this.pty) return;
    if (!this.mgr.claudeBin) throw new Error('claude CLI not found');
    fs.writeFileSync(this.controlFile, JSON.stringify({ cols, rows }));
    const args = ['--model', this.model, '--settings', this.mgr.settingsFile];
    // First start: our own id, and the context typed in as the first message.
    // Later: resume that same id.
    if (this.started) args.push('--resume', this.sessionId);
    else { args.push('--session-id', this.sessionId); if (this.prompt) args.push(this.prompt); }
    const env = { ...botEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    this.pty = spawn(PYTHON, [PTY_WRAPPER, this.controlFile, this.mgr.claudeBin, ...args], { cwd: this.mgr.vault, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.startedAt = Date.now();
    this.started = true;
    this.state = 'open';
    this.lastInput = Date.now();
    // Each handler acts only for ITS process: after sleep + a quick reopen,
    // the old process's exit fires once the new one runs, and must not clear
    // the new handle (that orphaned the new process; found by the tests).
    const p = this.pty;
    p.stdout.on('data', (d) => { if (this.pty === p) this.push(d.toString('utf8')); });
    p.stderr.on('data', (d) => { if (this.pty === p) this.push(d.toString('utf8')); });
    p.on('exit', (code) => {
      if (this.pty !== p) return;
      this.pty = null;
      if (this.state === 'open') this.state = 'asleep';
      this.push(`\r\n\x1b[90m— session stopped (${code}). Open it again to continue. —\x1b[0m\r\n`);
      this.broadcast({ type: 'state', state: this.state });
      this.mgr.save();
    });
    this.mgr.save();
  }

  push(text) {
    if (text.replace(OSC_ANY_RE, '').includes('\x07')) this.bell = true;
    this.replay += text;
    if (this.replay.length > MAX_REPLAY + REPLAY_SLACK) this.replay = this.replay.slice(-MAX_REPLAY);
    this.lastOut = Date.now();
    this.broadcast({ type: 'out', data: text });
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === 1) c.send(s);
  }

  write(data) {
    if (!this.pty) return;
    this.bell = false;
    this.lastInput = Date.now();
    try { this.pty.stdin.write(data); } catch {}
  }

  resize(cols, rows) {
    try {
      fs.writeFileSync(this.controlFile, JSON.stringify({ cols, rows }));
      if (this.pty && Date.now() - this.startedAt > SIGNAL_READY_MS) this.pty.kill('SIGUSR1');
    } catch {}
  }

  sleep() {
    if (this.pty) { try { this.pty.kill('SIGTERM'); } catch {} this.pty = null; }
    if (this.state === 'open') this.state = 'asleep';
    this.broadcast({ type: 'state', state: this.state });
    this.mgr.save();
  }

  // Done: stop, keep the transcript under .bot/sessions/.
  finish(outcome) {
    this.sleep();
    this.state = 'done';
    this.endedAt = Date.now();
    this.outcome = outcome || 'closed';
    this.mgr.keepTranscript(this);
    this.broadcast({ type: 'state', state: 'done', outcome: this.outcome });
    this.mgr.save();
  }

  toJSON() {
    return {
      id: this.id, sessionId: this.sessionId, title: this.title, kind: this.kind, item: this.item, model: this.model,
      outcomes: this.outcomes, suggest: this.suggest, state: this.state, activity: this.activity, running: this.running,
      createdAt: this.createdAt, lastInput: this.lastInput, endedAt: this.endedAt, outcome: this.outcome, started: this.started,
    };
  }
}

class Sessions {
  constructor({ vault, stateDir, claudeBin }) {
    this.vault = vault;
    this.claudeBin = claudeBin;
    this.dir = path.join(vault, '.bot', 'sessions');
    this.indexFile = path.join(this.dir, 'index.json');
    this.settingsFile = sessionSettings(stateDir);
    this.map = new Map();
    let recs = [];
    try { recs = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch {}
    // After an app restart nothing is running: open sessions are asleep.
    for (const r of recs) this.map.set(r.id, new Session(this, { ...r, state: r.state === 'open' ? 'asleep' : r.state }));
    this.cleanup();
    this.timer = setInterval(() => this.tick(), 60000);
    if (this.timer.unref) this.timer.unref();
  }

  limits() {
    const s = getConfig(this.vault).sessions;
    return { max: s.max_running, idleMs: s.idle_sleep_min * 60000, keepMs: s.keep_days * 864e5 };
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.indexFile, JSON.stringify([...this.map.values()].map((s) => s.toJSON()), null, 2));
  }

  list() { return [...this.map.values()].map((s) => s.toJSON()).sort((a, b) => b.createdAt - a.createdAt); }
  get(id) { return this.map.get(id); }

  // A new session. Starts it now (making room first).
  create({ title, kind, item, model, prompt, outcomes, suggest }) {
    const id = crypto.randomBytes(5).toString('hex');
    const s = new Session(this, { id, sessionId: crypto.randomUUID(), title: String(title || 'Session').slice(0, 120), kind, item, model, prompt, outcomes, suggest, state: 'asleep' });
    this.map.set(id, s);
    this.open(id);
    return s;
  }

  // Start or resume one, putting the oldest idle running session to sleep if
  // the limit is reached.
  open(id, cols, rows) {
    const s = this.get(id);
    if (!s) throw new Error('no such session');
    if (s.state === 'done') throw new Error('this session is done; start a new one');
    if (s.running) return s;
    const { max } = this.limits();
    const running = [...this.map.values()].filter((x) => x.running && x !== s);
    if (running.length >= max) {
      const idle = running.filter((x) => x.activity !== 'working' && x.activity !== 'attention').sort((a, b) => a.lastInput - b.lastInput)[0];
      // Never stop a session that is working or waiting on the owner.
      if (!idle) throw new Error(`all ${max} sessions are busy; put one to sleep or close it first`);
      idle.sleep();
    }
    s.start(cols, rows);
    return s;
  }

  // Idle sessions sleep; old transcripts go.
  tick() {
    const { idleMs } = this.limits();
    for (const s of this.map.values()) if (s.running && s.activity !== 'working' && Date.now() - s.lastInput > idleMs) s.sleep();
    this.cleanup();
  }

  // Claude Code files a transcript under its cwd with every non-alphanumeric
  // char turned into '-'. That cwd can be the resolved path (/private/var/…
  // for /var/…), so try both spellings.
  keepTranscript(s) {
    let real = this.vault; try { real = fs.realpathSync(this.vault); } catch {}
    for (const dir of [...new Set([this.vault, real])]) {
      const src = path.join(os.homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'), `${s.sessionId}.jsonl`);
      if (!fs.existsSync(src)) continue;
      try { fs.mkdirSync(this.dir, { recursive: true }); fs.copyFileSync(src, path.join(this.dir, `${s.id}.jsonl`)); } catch {}
      return;
    }
  }

  cleanup() {
    const { keepMs } = this.limits();
    let changed = false;
    for (const s of [...this.map.values()]) {
      if (s.state === 'done' && s.endedAt && Date.now() - s.endedAt > keepMs) {
        try { fs.rmSync(path.join(this.dir, `${s.id}.jsonl`), { force: true }); } catch {}
        this.map.delete(s.id); changed = true;
      }
    }
    if (changed) this.save();
  }

  stopAll() { for (const s of this.map.values()) if (s.running) s.sleep(); }
}

// python3 with pty, for the doctor (OV-e). Never runs the /usr/bin/python3 shim
// without the Command Line Tools (it would open Apple's install dialog).
function ptyOk() {
  if (spawnSync('/usr/bin/xcode-select', ['-p'], { timeout: 5000 }).status !== 0) return false;
  return spawnSync(PYTHON, ['-c', 'import pty'], { timeout: 10000 }).status === 0;
}

module.exports = { Sessions, Session, sessionSettings, ptyOk, PROMPT_RE };
