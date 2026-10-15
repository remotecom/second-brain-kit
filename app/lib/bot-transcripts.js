// The ingest bot's own Claude Code transcripts. Ingest is the one bot that
// keeps its session on disk (persist: true), only so a part can retry once in
// the same session (--resume). After the part, nothing reads that transcript:
// a stopped run resumes from .bot/state/ingest-progress.json, not from it.
// Setup keeps transcripts for good (retention.js), so without this the vault's
// transcript folder fills with ingest runs (measured 2026-10-15: 346 files,
// 235 MB, against 262 of the owner's own sessions).
//
//   remove(vault, ids)  a part passed: delete its transcripts now.
//   sweep(vault)        at the start of each ingest: delete ingest transcripts
//                       older than KEEP_FAILED_DAYS. A failed part's
//                       transcript stays that long, to see what went wrong.
//
// A file is an ingest transcript only when Claude Code marked it as a -p run
// (entrypoint sdk-cli) AND its first prompt is the ingest bot's. The owner's
// own sessions are never touched, even one that pastes the ingest prompt.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { transcriptDirs } = require('./session-raw');

const MARK = "You are the vault's ingest bot, running unattended.";
const KEEP_FAILED_DAYS = 14;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The first prompt and the entrypoint, from the head of the file. The
// ingest prompt is one line of about 70 KB, so read well past it.
function head(file) {
  let fd, len = 0; const buf = Buffer.alloc(1024 * 1024);
  try { fd = fs.openSync(file, 'r'); len = fs.readSync(fd, buf, 0, buf.length, 0); } catch { return {}; } finally { if (fd !== undefined) fs.closeSync(fd); }
  let entrypoint = '', prompt = '';
  for (const line of buf.toString('utf8', 0, len).split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.entrypoint && !entrypoint) entrypoint = j.entrypoint;
    if (j.type === 'user' && !prompt) {
      const c = j.message && j.message.content;
      prompt = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((x) => (x && x.text) || '').join('') : '');
    }
    if (entrypoint && prompt) break;
  }
  return { entrypoint, prompt };
}

const isIngest = (file) => { const h = head(file); return h.entrypoint === 'sdk-cli' && h.prompt.startsWith(MARK); };

function drop(dir, id) {
  const f = path.join(dir, `${id}.jsonl`);
  if (!fs.existsSync(f) || !isIngest(f)) return false;
  fs.rmSync(f, { force: true });
  fs.rmSync(path.join(dir, id), { recursive: true, force: true }); // tool-result spill, if any
  return true;
}

// Returns how many transcripts it deleted.
function remove(vault, ids, { home = os.homedir() } = {}) {
  let n = 0;
  for (const id of new Set(ids)) {
    if (!ID.test(String(id))) continue;
    for (const d of transcriptDirs(vault, home)) if (drop(d, id)) n++;
  }
  return n;
}

// Returns { deleted, bytes }.
function sweep(vault, { home = os.homedir(), days = KEEP_FAILED_DAYS, now = Date.now() } = {}) {
  const out = { deleted: 0, bytes: 0 };
  for (const d of transcriptDirs(vault, home)) {
    let names = []; try { names = fs.readdirSync(d); } catch { continue; }
    for (const name of names) {
      const id = name.replace(/\.jsonl$/, '');
      if (id === name || !ID.test(id)) continue;
      const f = path.join(d, name);
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (now - st.mtimeMs < days * 86400000) continue;
      if (drop(d, id)) { out.deleted++; out.bytes += st.size; }
    }
  }
  return out;
}

module.exports = { MARK, KEEP_FAILED_DAYS, remove, sweep, isIngest };
