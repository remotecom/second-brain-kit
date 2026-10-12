// Is each declared exclusion still catching anything? (OV6) An exclusion that
// matches nothing for a week has usually stopped working (a folder moved or
// Google changed a layout), and that failure is silent: fewer files are
// excluded, more reach the vault. Syncs report hits; Verify reads the gaps.
//
// .bot/state/exclusion-hits.json: { "<key>": { since: iso, last: iso|null } }

const fs = require('fs');
const path = require('path');

const FILE = (vault) => path.join(vault, '.bot', 'state', 'exclusion-hits.json');
const read = (vault) => { try { return JSON.parse(fs.readFileSync(FILE(vault), 'utf8')); } catch { return {}; } };

// keys: every configured exclusion; hits: the keys that matched this run.
function report(vault, keys, hits) {
  const all = read(vault);
  const now = new Date().toISOString();
  for (const k of keys) {
    all[k] = all[k] || { since: now, last: null };
    if (hits.has(k)) all[k].last = now;
  }
  for (const k of Object.keys(all)) if (!keys.includes(k) && k.split(':')[0] === (keys[0] || '').split(':')[0]) delete all[k];
  fs.mkdirSync(path.dirname(FILE(vault)), { recursive: true });
  fs.writeFileSync(FILE(vault), JSON.stringify(all, null, 2));
}

// Exclusions with no hit for `days` (counted from when they were first seen).
function quiet(vault, days = 7) {
  const out = [];
  for (const [k, v] of Object.entries(read(vault))) {
    const ref = Date.parse(v.last || v.since);
    if (Number.isFinite(ref) && Date.now() - ref > days * 864e5) out.push({ key: k, last: v.last });
  }
  return out;
}

module.exports = { report, quiet };
