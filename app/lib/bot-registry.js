// Bots added as files: app/bots/<id>.js, one bot each (docs/framework/bot.md).
// A new bot needs no edit to brain.js or to the nav: the app loads every file
// here at start, and the bot shows in the group it names.
//
//   module.exports = {
//     id: 'stale-pages', name: 'Stale pages', kind: 'bash',   // or 'model'
//     group: 'g-checks',                                      // a nav group id; else "Other"
//     blurb: 'What it does and what it costs.',
//     run: async (run, { claudeBin, vault, env, logLine, finish, runBot }, body) => { ... },
//   };
//
// A broken file never stops the app: it is skipped, and the reason is
// returned so the app can log it.

const fs = require('fs');
const path = require('path');

const KINDS = ['model', 'bash'];
const ID = /^[a-z][a-z0-9-]{1,40}$/;

function validate(b, file, taken) {
  if (!b || typeof b !== 'object') return 'it exports nothing';
  if (!ID.test(String(b.id))) return `id "${b.id}" must be lowercase letters, digits and dashes`;
  if (`${b.id}.js` !== file) return `id "${b.id}" must match the file name`;
  if (taken.has(b.id)) return `id "${b.id}" is already a bot`;
  if (!b.name || typeof b.name !== 'string') return 'no name';
  if (!KINDS.includes(b.kind)) return `kind must be ${KINDS.join(' or ')}`;
  if (!b.blurb || typeof b.blurb !== 'string') return 'no blurb (the board shows what it does and costs)';
  if (typeof b.run !== 'function') return 'no run function';
  if (b.group != null && typeof b.group !== 'string') return 'group must be a nav group id';
  return null;
}

function load(dir, takenIds = []) {
  const taken = new Set(takenIds);
  const bots = [], skipped = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort(); } catch { return { bots, skipped }; }
  for (const f of files) {
    let b;
    try { b = require(path.join(dir, f)); } catch (e) { skipped.push({ file: f, why: `it does not load: ${e.message.split('\n')[0]}` }); continue; }
    const why = validate(b, f, taken);
    if (why) { skipped.push({ file: f, why }); continue; }
    taken.add(b.id);
    bots.push({ id: b.id, name: b.name, kind: b.kind, group: b.group || null, blurb: b.blurb, run: b.run });
  }
  return { bots, skipped };
}

module.exports = { load, validate };
