// Claude Code deletes a project's transcript dir when the project has not
// been opened for cleanupPeriodDays (default 30). Before the vault owned
// project memory, that dir held the memories too: on the first vault six
// projects lost all of theirs this way (2026-07-21), and their wiki
// citations became dead links. Setup sets it high, in ~/.claude/settings.json,
// and keeps every other key. The doctor flags it when it is low.
//
// The setting is for the whole Mac, not only the vault: transcripts of every
// project are kept. That is the point (they are the record), and it costs disk.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEEP_DAYS = 36500; // 100 years: in practice, never

const file = (home = os.homedir()) => path.join(home, '.claude', 'settings.json');

// { ok, days, file, error }, changing nothing.
function check(home) {
  const f = file(home);
  if (!fs.existsSync(f)) return { ok: false, days: null, file: f };
  try {
    const days = Number(JSON.parse(fs.readFileSync(f, 'utf8')).cleanupPeriodDays);
    return { ok: Number.isFinite(days) && days >= KEEP_DAYS, days: Number.isFinite(days) ? days : null, file: f };
  } catch (e) { return { ok: false, days: null, file: f, error: `${f} does not parse (${e.message})` }; }
}

// Sets it when missing or lower. Returns 'set' or 'already'. Throws when the
// file does not parse: it is the person's own settings, never overwritten
// unread.
function ensure(home) {
  const c = check(home);
  if (c.ok) return 'already';
  if (c.error) throw new Error(c.error);
  const j = fs.existsSync(c.file) ? JSON.parse(fs.readFileSync(c.file, 'utf8')) : {};
  j.cleanupPeriodDays = KEEP_DAYS;
  fs.mkdirSync(path.dirname(c.file), { recursive: true });
  fs.writeFileSync(c.file, `${JSON.stringify(j, null, 2)}\n`);
  return 'set';
}

module.exports = { KEEP_DAYS, check, ensure, file };
