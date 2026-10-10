// Where each side of a contradiction comes from (decision A7). Ingest names,
// for each claim, the wiki page, the file it is written in and a short exact
// quote. CODE checks the quote is really in that file and finds its line;
// an unchecked side is dropped. Stored in .bot/state/claim-sources.json,
// keyed by the Needs-You item id (the same id Verify gives it). After Resolve
// applies the owner's answer, the quotes are dropped and the links stay.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_QUOTE = 300;
const FILE = (vault) => path.join(vault, '.bot', 'state', 'claim-sources.json');
const idOf = (text) => `c-${crypto.createHash('sha1').update(String(text).toLowerCase()).digest('hex').slice(0, 7)}`;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function readAll(vault) { try { return JSON.parse(fs.readFileSync(FILE(vault), 'utf8')); } catch { return {}; } }
function writeAll(vault, all) { fs.mkdirSync(path.dirname(FILE(vault)), { recursive: true }); fs.writeFileSync(FILE(vault), JSON.stringify(all, null, 2)); }

// One side: { page, file, quote } -> { page, file, line, quote } or null.
function checkSide(vault, side) {
  if (!side || typeof side !== 'object') return null;
  const rel = String(side.file || side.page || '').replace(/^\.?\//, '');
  const quote = norm(side.quote).slice(0, MAX_QUOTE);
  if (!rel || !quote || rel.includes('..') || !rel.endsWith('.md')) return null;
  let text;
  try { text = fs.readFileSync(path.join(vault, rel), 'utf8'); } catch { return null; }
  const flat = norm(text);
  if (!flat.includes(quote)) return null;
  // The line the quote starts on: find its first 40 chars line by line.
  const head = quote.slice(0, 40);
  const lines = text.split('\n');
  let line = 0;
  // The quote starts on the LAST line whose 4-line window still holds its
  // first 40 chars (an earlier window holds it too, from a line before).
  for (let i = 0; i < lines.length; i++) if (norm(lines.slice(i, i + 4).join(' ')).includes(head)) line = i + 1; else if (line) break;
  const page = String(side.page || '').startsWith('wiki/') ? String(side.page) : rel.startsWith('wiki/') ? rel : null;
  return { page, file: rel, line, quote };
}

// From ingest: contradictions as strings (old form) or { text, a, b }.
// Returns the texts for the log, and records the checked sources.
function recordFromManifest(vault, list) {
  const texts = [];
  const all = readAll(vault);
  let kept = 0, dropped = 0;
  for (const c of list || []) {
    const text = typeof c === 'string' ? c : norm(c && c.text);
    if (!text) continue;
    texts.push(text);
    if (typeof c !== 'object') continue;
    const a = checkSide(vault, c.a), b = checkSide(vault, c.b);
    kept += (a ? 1 : 0) + (b ? 1 : 0);
    dropped += (c.a && !a ? 1 : 0) + (c.b && !b ? 1 : 0);
    if (a || b) all[idOf(text)] = { a, b, at: new Date().toISOString() };
  }
  if (kept) writeAll(vault, all);
  return { texts, kept, dropped };
}

function get(vault, id) { return readAll(vault)[id] || null; }

// After the answer is applied: keep where, drop what (the quote).
function dropQuotes(vault, id) {
  const all = readAll(vault);
  if (!all[id]) return;
  for (const k of ['a', 'b']) if (all[id][k]) delete all[id][k].quote;
  all[id].resolved = new Date().toISOString();
  writeAll(vault, all);
}

module.exports = { idOf, checkSide, recordFromManifest, get, dropQuotes, readAll, MAX_QUOTE };
