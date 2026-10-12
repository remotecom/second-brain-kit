// Settings for the bots, from <vault>/config.yaml (the kit's one config file).
// config.example.yaml in the kit root is the schema: every key, with its
// default and an explanation. Nothing about a specific person or company is
// hardcoded in the bots; a teammate's install differs only in this file.
//
//   getConfig(vault)       the whole config, defaults filled in, legacy keys mapped
//   readOwner(vault)       owner block (+ notion/.user-id fallback)
//   requireOwner(vault, k) owner block, or a readable error naming missing keys
//   validate(vault)        [{level, key, message}] for the doctor and Setup
//   migrateConfig(text)    text with missing keys added; never changes a value
//   convertLegacy(text)    a version-1 config moved to the version-2 layout
//
// Parsing is js-yaml (vendored, zero dependencies, lib/vendor/). Writes are
// TEXT edits, never a re-dump, so the owner's comments survive.

const fs = require('fs');
const path = require('path');
const yaml = require('./vendor/js-yaml');

const EXAMPLE = path.resolve(__dirname, '..', '..', 'config.example.yaml');
const CONFIG_VERSION = 2;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const clone = (x) => JSON.parse(JSON.stringify(x));

// --- defaults ------------------------------------------------------------------

let defaultsCache = null;
// The example file is the schema. Person-specific values in it are
// placeholders, so they are blanked rather than used as defaults.
function defaults() {
  if (defaultsCache) return clone(defaultsCache);
  const d = yaml.load(fs.readFileSync(EXAMPLE, 'utf8')) || {};
  d.owner = { name: '', email: '', slack_user_id: '', slack_self_dm_id: '', notion_user_id: '', timezone: localZone() };
  d.sources.gcal.calendars = [];
  defaultsCache = d;
  return clone(d);
}

function localZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

// Deep merge: arrays and scalars from `over` replace; objects merge.
function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

// --- loading ---------------------------------------------------------------------

const cache = new Map(); // file -> { mtimeMs, data, error }

function loadRaw(vault) {
  const file = path.join(vault, 'config.yaml');
  let st;
  try { st = fs.statSync(file); } catch { return { data: {}, error: null, missing: true }; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit;
  let data = {}, error = null;
  try { data = yaml.load(fs.readFileSync(file, 'utf8')) || {}; if (!isObj(data)) throw new Error('the top level is not a mapping'); }
  catch (e) { data = {}; error = `config.yaml does not parse: ${String(e.message).split('\n')[0]}`; }
  const rec = { mtimeMs: st.mtimeMs, data, error, missing: false };
  cache.set(file, rec);
  return rec;
}

// Version-1 configs (before 2026-10) kept some keys elsewhere. Read them where
// they are, so an unconverted vault keeps working.
const DRIVE_ID = /^[A-Za-z0-9_-]{20,}$/;
function normalizeLegacy(src) {
  const d = clone(src);
  d.sources = isObj(d.sources) ? d.sources : {};
  const s = (k) => (d.sources[k] = isObj(d.sources[k]) ? d.sources[k] : {});
  if (isObj(d.gcal)) {
    if (d.gcal.calendars && s('gcal').calendars === undefined) s('gcal').calendars = d.gcal.calendars;
    delete d.gcal;
  }
  if (isObj(d.gdrive)) {
    if (d.gdrive.exclude_folders && s('gdrive').exclude_folders === undefined) s('gdrive').exclude_folders = d.gdrive.exclude_folders;
    delete d.gdrive;
  }
  for (const v of Object.values(d.sources)) {
    if (!isObj(v)) continue;
    if (v.rolling_window_days !== undefined && v.window_days === undefined) v.window_days = v.rolling_window_days;
    delete v.rolling_window_days;
  }
  const lin = d.sources.linear;
  if (isObj(lin) && lin.team_key !== undefined) {
    lin.scope = isObj(lin.scope) ? lin.scope : {};
    if (!lin.scope.team && !/^TEAM$/.test(lin.team_key)) lin.scope.team = lin.team_key;
    delete lin.team_key;
  }
  const no = d.sources.notion;
  if (isObj(no) && no.watched_databases !== undefined && no.watched === undefined) { no.watched = no.watched_databases; delete no.watched_databases; }
  // v1 mixed folder titles and IDs in one list.
  const gd = d.sources.gdrive;
  if (Number(d.config_version || 1) < 2 && isObj(gd) && Array.isArray(gd.exclude_folders) && gd.exclude_folders.some((x) => !DRIVE_ID.test(String(x)))) {
    const titles = gd.exclude_folders.filter((x) => !DRIVE_ID.test(String(x)));
    gd.exclude_folders = gd.exclude_folders.filter((x) => DRIVE_ID.test(String(x)));
    gd.exclude_folder_titles = [...new Set([...(gd.exclude_folder_titles || []), ...titles])];
  }
  if (isObj(d.ingest) && d.ingest.stop_words !== undefined) {
    d.route = isObj(d.route) ? d.route : {};
    if (d.route.stop_words === undefined) d.route.stop_words = d.ingest.stop_words;
    delete d.ingest.stop_words;
  }
  return d;
}

function getConfig(vault) {
  const raw = loadRaw(vault);
  const cfg = merge(defaults(), normalizeLegacy(raw.data));
  // A null list ("exclude:" with nothing under it) means empty, not "default".
  for (const [k, v] of Object.entries(defaults().sources)) {
    for (const [kk, vv] of Object.entries(v)) if (Array.isArray(vv) && cfg.sources[k][kk] == null) cfg.sources[k][kk] = [];
  }
  if (cfg.ingest.exclude == null) cfg.ingest.exclude = [];
  if (cfg.linear.deep_initiatives == null) cfg.linear.deep_initiatives = [];
  if (cfg.route.stop_words == null) cfg.route.stop_words = [];
  // A bad zone must not break every page that formats a date: use the Mac's
  // zone and let validate() report the bad value.
  if (!validZone(cfg.owner.timezone)) cfg.owner.timezone = localZone();
  Object.defineProperty(cfg, '_meta', { value: { error: raw.error, missing: raw.missing } });
  return cfg;
}

// --- owner -------------------------------------------------------------------------

function readOwner(vault) {
  const owner = { ...getConfig(vault).owner };
  for (const k of Object.keys(owner)) owner[k] = owner[k] == null ? '' : String(owner[k]);
  if (!owner.notion_user_id) {
    try { owner.notion_user_id = fs.readFileSync(path.join(vault, 'notion', '.user-id'), 'utf8').trim(); } catch {}
  }
  return owner;
}

const placeholder = (v) => !v || /X{4,}|^Your Name$|@example\.com$/.test(v);

// Throws a readable error naming the missing keys, for the board to show.
function requireOwner(vault, keys) {
  const owner = readOwner(vault);
  const missing = keys.filter((k) => placeholder(owner[k]));
  if (missing.length) throw new Error(`set ${missing.map((k) => `owner.${k}`).join(', ')} in ${path.join(vault, 'config.yaml')}`);
  return owner;
}

// --- validation ----------------------------------------------------------------------

const USAGE_SHARES = ['light', 'normal', 'heavy'];

function validZone(z) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; }
}

// Findings for the doctor and the Setup page. error = a bot cannot run;
// warn = it runs but something is off.
function validate(vault) {
  const raw = loadRaw(vault);
  const out = [];
  const add = (level, key, message) => out.push({ level, key, message });
  if (raw.missing) { add('error', 'config.yaml', `no config.yaml in ${vault}. Run Setup.`); return out; }
  if (raw.error) { add('error', 'config.yaml', raw.error); return out; }
  const c = getConfig(vault);
  const known = new Set([...Object.keys(defaults()), 'gcal', 'gdrive']);
  for (const k of Object.keys(raw.data)) if (!known.has(k)) add('warn', k, `unknown key "${k}" (a typo?). The app ignores it.`);
  if (Number(raw.data.config_version || 1) < CONFIG_VERSION) add('warn', 'config_version', 'config.yaml uses the old (version 1) layout. Everything still works.');

  if (placeholder(c.owner.name)) add('error', 'owner.name', 'set owner.name');
  const rawZone = raw.data.owner && raw.data.owner.timezone;
  if (rawZone && !validZone(rawZone)) add('error', 'owner.timezone', `owner.timezone "${rawZone}" is not a time zone (use a name like America/New_York)`);
  const src = c.sources;
  if (src.slack.enabled && placeholder(c.owner.slack_user_id)) add('error', 'owner.slack_user_id', 'set owner.slack_user_id (Slack profile → More → Copy member ID)');
  for (const [name, s] of Object.entries(src)) {
    if (!isObj(s)) { add('error', `sources.${name}`, `sources.${name} must be a mapping`); continue; }
    if (typeof s.enabled !== 'boolean') add('error', `sources.${name}.enabled`, `sources.${name}.enabled must be true or false`);
    if (!(Number.isInteger(s.window_days) && s.window_days >= 1 && s.window_days <= 30)) add('error', `sources.${name}.window_days`, `sources.${name}.window_days must be a whole number from 1 to 30`);
  }
  if (src.gcal.enabled && !(src.gcal.calendars || []).length) add('error', 'sources.gcal.calendars', 'list at least one calendar under sources.gcal.calendars, or set enabled: false');
  if (src.linear.enabled) {
    const sc = src.linear.scope || {};
    const n = [sc.initiative, sc.team].filter(Boolean).length;
    if (n !== 1) add(n ? 'error' : 'warn', 'sources.linear.scope', n ? 'Set ONE of sources.linear.scope.initiative or .team, not both.' : 'Linear scope is not in config.yaml yet. The saved scope (linear/.initiative-scope.json) is used.');
  }
  for (const [k, v] of Object.entries(c.connectors || {})) {
    if (!/^mcp__[A-Za-z0-9_-]+$/.test(String(v || ''))) add('error', `connectors.${k}`, `connectors.${k} must look like mcp__claude_ai_Name (the part before the double underscore)`);
  }
  if (![3, 7, 14, 30].includes(c.bootstrap_days)) add('warn', 'bootstrap_days', 'bootstrap_days is usually 3, 7, 14 or 30');
  const sch = c.schedule;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(sch.morning_at))) add('error', 'schedule.morning_at', 'schedule.morning_at must be HH:MM, e.g. "06:00"');
  for (const k of ['ingest_min_files', 'ingest_max_days']) if (!(Number.isInteger(sch[k]) && sch[k] >= 1)) add('error', `schedule.${k}`, `schedule.${k} must be a whole number of 1 or more`);
  if (!USAGE_SHARES.includes(c.usage_share)) add('error', 'usage_share', 'usage_share must be light, normal or heavy');
  const ses = c.sessions;
  if (!(Number.isInteger(ses.max_running) && ses.max_running >= 1 && ses.max_running <= 8)) add('error', 'sessions.max_running', 'sessions.max_running must be from 1 to 8');
  for (const [k, v] of [['ingest.exclude', c.ingest.exclude], ['linear.deep_initiatives', c.linear.deep_initiatives], ['route.stop_words', c.route.stop_words], ['wiki.sections', c.wiki.sections], ['tags.namespaces', c.tags.namespaces]]) {
    if (!Array.isArray(v)) add('error', k, `${k} must be a list`);
  }
  return out;
}

// --- text edits (migrate / convert) -----------------------------------------------------

const indentOf = (l) => l.match(/^ */)[0].length;
const isContent = (l) => /\S/.test(l) && !/^\s*#/.test(l);
const keyRe = (k) => new RegExp(`^( *)${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\s|$)`);

// The line range of the mapping at keyPath: [header, end) where end is the
// first content line back at or above the header's indent. null if absent.
function findBlock(lines, keyPath) {
  let from = 0, to = lines.length, indent = -1, header = -1;
  for (const k of keyPath) {
    let found = -1, child = -1;
    for (let i = from; i < to; i++) {
      if (!isContent(lines[i])) continue;
      const ind = indentOf(lines[i]);
      if (ind <= indent) break;
      // Direct children share the indent of the first content line.
      if (child < 0) child = indent < 0 ? 0 : ind;
      if (ind === child && keyRe(k).test(lines[i])) { found = i; break; }
    }
    if (found < 0) return null;
    header = found; indent = indentOf(lines[found]);
    let end = found + 1;
    // A compact list ("key:" then "- item" at the same indent) belongs to its key.
    const compact = !/:\s*[^\s#]/.test(lines[found].replace(/#.*$/, ''));
    while (end < to && (!isContent(lines[end]) || indentOf(lines[end]) > indent || (compact && indentOf(lines[end]) === indent && /^\s*- /.test(lines[end])))) end++;
    // Trailing blank/comment lines belong to whatever follows.
    while (end > found + 1 && !isContent(lines[end - 1])) end--;
    from = found + 1; to = end;
  }
  return { header, end: to, indent };
}

// Indent of the direct children of a block (2 more than the header if empty).
function childIndent(lines, b) {
  for (let i = b.header + 1; i < b.end; i++) if (isContent(lines[i])) return indentOf(lines[i]);
  return b.indent + 2;
}

const dumpKey = (k, v, ind) => yaml.dump({ [k]: v }, { lineWidth: 1000, quotingType: '"' }).trimEnd().split('\n').map((l) => ' '.repeat(ind) + l);

// True when the value at keyPath is written inline (`key: value` or `key: [..]`),
// so children cannot be added under it as lines.
function inlineValue(lines, b) {
  return /:\s*[^\s#]/.test(lines[b.header].replace(/#.*$/, ''));
}

// Add every key the schema has and the text lacks, as text, with defaults.
// Never edits an existing line; then proves it changed no value.
const OWNED_MAPS = new Set(['wiki.section_notes']);

function migrateConfig(text, schema = defaults()) {
  const before = yaml.load(text) || {};
  const lines = text.split('\n');
  const added = [];
  const walk = (node, have, keyPath) => {
    for (const [k, v] of Object.entries(node)) {
      const p = [...keyPath, k];
      if (have && Object.prototype.hasOwnProperty.call(have, k)) {
        // A map whose keys are the owner's own (one note per THEIR wiki
        // section) is never filled in from the defaults.
        if (isObj(v) && isObj(have[k]) && !OWNED_MAPS.has(p.join('.'))) {
          const b = findBlock(lines, p);
          if (b && !inlineValue(lines, b)) walk(v, have[k], p);
        }
        continue;
      }
      // Missing: insert at the end of the parent block, or the end of the file.
      const val = k === 'config_version' ? 1 : v; // an old file is version 1 until converted
      if (keyPath.length === 0) {
        while (lines.length && lines[lines.length - 1] === '') lines.pop();
        lines.push('', ...dumpKey(k, val, 0), '');
      } else {
        const b = findBlock(lines, keyPath);
        if (!b || inlineValue(lines, b)) continue;
        lines.splice(b.end, 0, ...dumpKey(k, val, childIndent(lines, b)));
      }
      added.push(p.join('.'));
    }
  };
  walk(schema, before, []);
  const out = lines.join('\n');
  const after = yaml.load(out) || {};
  assertKept(before, after);
  return { text: out, added };
}

// Every value in `before` is unchanged in `after`.
function assertKept(before, after, p = '') {
  if (isObj(before)) {
    if (!isObj(after)) throw new Error(`migrate changed ${p || 'the top level'}`);
    for (const [k, v] of Object.entries(before)) assertKept(v, after[k], p ? `${p}.${k}` : k);
  } else if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`migrate changed ${p}`);
}

// Move a block's lines (comments inside it included) to under destPath,
// renaming its key. destPath must exist as a block-style mapping.
function moveBlock(lines, fromPath, destPath, newKey) {
  const b = findBlock(lines, fromPath);
  const d = findBlock(lines, destPath);
  if (!b || !d) return false;
  // Comment lines right above the block travel with it.
  let start = b.header;
  while (start > 0 && /^\s*#/.test(lines[start - 1])) start--;
  const chunk = lines.slice(start, b.end);
  const target = childIndent(lines, d);
  const shift = target - b.indent;
  const moved = chunk.map((l, i) => {
    if (!/\S/.test(l)) return l;
    const re = shift >= 0 ? ' '.repeat(shift) + l : l.slice(Math.min(-shift, indentOf(l)));
    return i === b.header - start ? re.replace(keyRe(fromPath[fromPath.length - 1]), `$1${newKey}:$2`) : re;
  });
  lines.splice(start, b.end - start);
  // Drop a now-empty parent (e.g. a top-level gcal: holding only calendars).
  const d2 = findBlock(lines, destPath);
  lines.splice(d2.end, 0, ...moved);
  return true;
}

function leadingComments(lines, keyPath) {
  const b = findBlock(lines, keyPath);
  if (!b) return [];
  let start = b.header;
  while (start > 0 && /^\s*#/.test(lines[start - 1])) start--;
  return lines.slice(start, b.header);
}

function ensureBlock(lines, keyPath) {
  if (findBlock(lines, keyPath)) return;
  ensureBlock(lines, keyPath.slice(0, -1).length ? keyPath.slice(0, -1) : []);
  const k = keyPath[keyPath.length - 1];
  if (keyPath.length === 1) { while (lines.length && lines[lines.length - 1] === '') lines.pop(); lines.push('', `${k}:`); return; }
  const p = findBlock(lines, keyPath.slice(0, -1));
  lines.splice(p.end, 0, `${' '.repeat(childIndent(lines, p))}${k}:`);
}

function dropIfEmpty(lines, keyPath) {
  const b = findBlock(lines, keyPath);
  if (!b) return;
  for (let i = b.header + 1; i < b.end; i++) if (isContent(lines[i])) return;
  if (inlineValue(lines, b)) return;
  let start = b.header;
  while (start > 0 && /^\s*#/.test(lines[start - 1])) start--;
  lines.splice(start, b.end - start);
}

function renameKey(lines, keyPath, newKey) {
  const b = findBlock(lines, keyPath);
  if (!b) return false;
  lines[b.header] = lines[b.header].replace(keyRe(keyPath[keyPath.length - 1]), `$1${newKey}:$2`);
  return true;
}

// Version 1 -> 2: move keys to their new homes as text (comments travel with
// them), then add every missing key. The result must mean the same as the
// input under normalizeLegacy().
function convertLegacy(text) {
  const data = yaml.load(text) || {};
  if (Number(data.config_version || 1) >= CONFIG_VERSION) return migrateConfig(text);
  const lines = text.split('\n');
  const moves = [];
  const mv = (from, dest, key) => { ensureBlock(lines, dest); if (moveBlock(lines, from, dest, key)) moves.push(`${from.join('.')} → ${[...dest, key].join('.')}`); };
  // A v1 top-level gcal:/gdrive: block becomes sources.gcal/gdrive. Its
  // leading comment explains it, so the comment moves too.
  for (const name of ['gcal', 'gdrive']) {
    if (!isObj(data[name])) continue;
    const head = leadingComments(lines, [name]);
    const keys = Object.keys(data[name]);
    for (const k of keys) mv([name, k], ['sources', name], k);
    dropIfEmpty(lines, [name]);
    const first = keys.length && findBlock(lines, ['sources', name, keys[0]]);
    if (first && head.length) lines.splice(first.header, 0, ...head.map((l) => ' '.repeat(first.indent) + l.trimStart()));
  }
  if (isObj(data.ingest) && data.ingest.stop_words !== undefined) mv(['ingest', 'stop_words'], ['route'], 'stop_words');
  for (const [name, s] of Object.entries(isObj(data.sources) ? data.sources : {})) {
    if (!isObj(s)) continue;
    if (s.rolling_window_days !== undefined && renameKey(lines, ['sources', name, 'rolling_window_days'], 'window_days')) moves.push(`sources.${name}.rolling_window_days → window_days`);
    if (name === 'notion' && s.watched_databases !== undefined && renameKey(lines, ['sources', 'notion', 'watched_databases'], 'watched')) moves.push('sources.notion.watched_databases → watched');
  }
  // config_version: set it to 2 (it is added as 1 by migrate if absent).
  let out = lines.join('\n');
  if (/^config_version:/m.test(out)) out = out.replace(/^config_version:.*$/m, `config_version: ${CONFIG_VERSION}`);
  else out = `config_version: ${CONFIG_VERSION}\n\n${out}`;
  out = out.replace(/\n{3,}/g, '\n\n');
  const res = migrateConfig(out);
  // Same meaning before and after, apart from the version stamp.
  const a = normalizeLegacy(data), b = normalizeLegacy(yaml.load(res.text) || {});
  delete a.config_version; delete b.config_version;
  assertKept(a, b);
  return { text: res.text, added: res.added, moves };
}

// Set values by key path, as TEXT: comments and every other value survive.
// values: { 'owner.name': 'Sam', 'sources.gcal.calendars': ['a@b.com'] }.
// A key that exists is replaced in place (its lines, not its neighbours'); a
// missing one is added to its parent block (created if needed). Then proves
// that no other value changed.
function setValues(text, values) {
  const before = yaml.load(text) || {};
  const lines = text.split('\n');
  for (const [dotted, value] of Object.entries(values)) {
    const keyPath = dotted.split('.');
    const parent = keyPath.slice(0, -1), key = keyPath[keyPath.length - 1];
    const b = findBlock(lines, keyPath);
    if (b) {
      // Keep a trailing comment on a one-line scalar ("name: x   # me").
      const comment = (lines[b.header].match(/\s+#.*$/) || [''])[0];
      const repl = dumpKey(key, value, b.indent);
      if (repl.length === 1 && !isObj(value) && !Array.isArray(value) && comment && b.end === b.header + 1) repl[0] += comment;
      lines.splice(b.header, b.end - b.header, ...repl);
      continue;
    }
    if (parent.length) {
      ensureBlock(lines, parent);
      const pb = findBlock(lines, parent);
      if (inlineValue(lines, pb)) throw new Error(`${parent.join('.')} is written inline; edit it by hand`);
      lines.splice(pb.end, 0, ...dumpKey(key, value, childIndent(lines, pb)));
    } else {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.push('', ...dumpKey(key, value, 0), '');
    }
  }
  const out = lines.join('\n');
  const after = yaml.load(out) || {};
  // Every value not set here is unchanged.
  const strip = (o) => { const c = clone(o); for (const k of Object.keys(values)) { const ks = k.split('.'); let x = c; for (const p of ks.slice(0, -1)) x = x && x[p]; if (x) delete x[ks[ks.length - 1]]; } return c; };
  assertKept(strip(before), strip(after));
  for (const [k, v] of Object.entries(values)) {
    const got = k.split('.').reduce((x, p) => (x == null ? x : x[p]), after);
    if (JSON.stringify(got) !== JSON.stringify(v)) throw new Error(`setValues: ${k} did not take`);
  }
  return out;
}

// Read config.yaml, set values, write it back. The app's only config writer.
function writeValues(vault, values) {
  const file = path.join(vault, 'config.yaml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  fs.writeFileSync(file, setValues(text, values));
  cache.delete(file);
}

module.exports = { setValues, writeValues, getConfig, readOwner, requireOwner, validate, migrateConfig, convertLegacy, defaults, normalizeLegacy, findBlock, CONFIG_VERSION, localZone };
