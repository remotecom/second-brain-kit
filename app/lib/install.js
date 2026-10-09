// Where this install keeps its own state, and which vault it serves.
// There is NO default vault (OV9): `second-brain setup` writes the choice to
// ~/.second-brain/settings.json. SECOND_BRAIN_VAULT overrides it (tests, a
// second dev instance); BRIEFCASE_VAULT is the older name for the same thing.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = process.env.SECOND_BRAIN_STATE_DIR || path.join(os.homedir(), '.second-brain');
const SETTINGS = path.join(STATE_DIR, 'settings.json');
const LABEL = 'dev.secondbrain.app';
const OLD_LABELS = ['com.remote.second-brain'];

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) || {}; } catch { return {}; }
}

function writeSettings(patch) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...readSettings(), ...patch };
  fs.writeFileSync(SETTINGS, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function resolveVault() {
  const v = process.env.SECOND_BRAIN_VAULT || process.env.BRIEFCASE_VAULT || readSettings().vault || '';
  return v ? path.resolve(v.replace(/^~(?=$|\/)/, os.homedir())) : '';
}

// The claude CLI: the usual install places, then PATH.
function findClaude() {
  const { execFileSync } = require('child_process');
  for (const p of [path.join(os.homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (fs.existsSync(p)) return p;
  }
  try { return execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

// `claude auth status` (JSON, no model call): logged in, and how.
function claudeAuth(bin) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
  const r = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 15000, env });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

const port = () => Number(process.env.SECOND_BRAIN_PORT || readSettings().port || 19300);

module.exports = { STATE_DIR, SETTINGS, LABEL, OLD_LABELS, readSettings, writeSettings, resolveVault, port, findClaude, claudeAuth };
