// Saved sessions: "Save & close" on an app session copies its transcript,
// verbatim, into the raw layer:
//
//   projects/sessions/<YYYY-MM-DD>-<first 8 of the Claude session id>.md
//
// one file per local day the session ran, never deleted. Ingest picks the
// files up on its normal schedule, like any other file under projects/; this
// module does not start an ingest and changes nothing about how ingest works.
// Only sessions the owner saves are copied (plain Close copies nothing), and
// only the app's sessions, which run in the vault.
//
// What is copied: the text of each turn, the owner's and Claude's. Not
// copied: tool calls and their output, hidden meta messages, sub-agent turns,
// slash-command bookkeeping, and the app's own opening instructions (the
// first message of a "Look into this" session is the app's, not the owner's).
// Credentials are redacted as the Slack sync redacts them. Code only, no
// model: what is relevant is ingest's call, never the copy's (RAW PURITY).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getConfig } = require('./config');
const { redact } = require('./redact');
const T = require('./time');

const DIR = 'projects/sessions';

const encode = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

// Claude Code files a transcript under its cwd with every non-alphanumeric
// char turned into '-'. The cwd can be the resolved path (/private/var/… for
// /var/…), so look under both spellings.
function transcriptFile(vault, sessionId, home = os.homedir()) {
  let real = vault; try { real = fs.realpathSync(vault); } catch {}
  for (const d of [...new Set([vault, real])]) {
    const f = path.join(home, '.claude', 'projects', encode(d), `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Text of one message, or '' when it carries none (tool use, tool result).
function textOf(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return (Array.isArray(m.content) ? m.content : []).filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
}

// Slash-command wrappers: Claude Code's own bookkeeping, not a turn.
const WRAPPER = /^\s*<(local-command-caveat|local-command-stdout|command-name|command-message|command-args)>/;

// One transcript → [{ ts, who, text }]. appPrompt: the app's opening
// message for this session, left out.
function readTurns(file, appPrompt = '') {
  const turns = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return turns; }
  const prompt = String(appPrompt || '').trim();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if ((j.type !== 'user' && j.type !== 'assistant') || j.isMeta || j.isSidechain) continue;
    const t = textOf(j.message);
    if (!t.trim() || (j.type === 'user' && (WRAPPER.test(t) || (prompt && t.trim() === prompt)))) continue;
    const ts = Date.parse(j.timestamp);
    if (Number.isNaN(ts)) continue;
    turns.push({ ts, who: j.type === 'user' ? 'You' : 'Claude', text: t.trimEnd() });
  }
  return turns;
}

const yq = (s) => JSON.stringify(String(s));

function render({ sessionId, day, title, kind, turns, tz, cap }) {
  let secrets = 0;
  let body = turns.map((t) => `### ${T.timeOf(t.ts, tz)} · ${t.who}\n\n${redact(t.text, () => { secrets++; })}\n`).join('\n');
  let cut = '';
  if (body.length > cap) { body = body.slice(0, cap); cut = `\n\n_Cut at sessions.max_day_chars (${cap} characters) in config.yaml._\n`; }
  const text = [
    '---',
    `name: ${yq(`${title} (${day})`)}`,
    'type: session',
    `session_id: ${sessionId}`,
    `session_kind: ${kind}`,
    `day: ${day}`,
    `title: ${yq(title)}`,
    `turns: ${turns.length}`,
    'source: claude-code',
    '---',
    '',
    `# ${title} (${day})`,
    '',
    body.trimEnd() + cut,
    '',
  ].join('\n');
  return { text, secrets };
}

// Save one app session. s: { sessionId, title, kind, prompt }. Returns
// { written: [rel], unchanged, secrets, turns }. Writes only what changed.
// The title is the one the session had when first saved: a later rename
// must not rewrite raw (ingest would read it all again).
function saveSession(vault, s, { home } = {}) {
  const cfg = getConfig(vault);
  const tz = cfg.owner.timezone;
  const cap = Number((cfg.sessions || {}).max_day_chars) > 0 ? Number(cfg.sessions.max_day_chars) : 300000;
  const res = { written: [], unchanged: 0, secrets: 0, turns: 0 };
  const file = transcriptFile(vault, s.sessionId, home);
  if (!file) return { ...res, error: 'no transcript found for this session' };
  const turns = readTurns(file, s.prompt);
  res.turns = turns.length;
  if (!turns.some((t) => t.who === 'You')) return { ...res, error: 'nothing you wrote in this session, so nothing to save' };
  const byDay = new Map();
  for (const t of turns) { const d = T.dayOf(t.ts, tz); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(t); }
  for (const [day, list] of byDay) {
    const rel = `${DIR}/${day}-${s.sessionId.slice(0, 8)}.md`;
    const out = path.join(vault, rel);
    let title = s.title || 'Claude session';
    if (fs.existsSync(out)) { const m = fs.readFileSync(out, 'utf8').match(/^title: (".*")$/m); if (m) { try { title = JSON.parse(m[1]); } catch {} } }
    const r = render({ sessionId: s.sessionId, day, title, kind: s.kind || 'chat', turns: list, tz, cap });
    res.secrets += r.secrets;
    if (fs.existsSync(out) && fs.readFileSync(out, 'utf8') === r.text) { res.unchanged++; continue; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, r.text);
    res.written.push(rel);
  }
  return res;
}

module.exports = { DIR, saveSession, readTurns, transcriptFile, render };
