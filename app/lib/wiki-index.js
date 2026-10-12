// Keep wiki/index.md listing every page. Mechanical, no model: a missing page
// gets one line under its section, "- [[wiki/<dir>/<slug>]] — <first sentence
// of its Overview>". People pages land under "### Not yet sorted" because the
// sub-group (external DRI, internal team) is a judgment for ingest or the owner.

const fs = require('fs');
const path = require('path');

const { getConfig } = require('./config');

// The index heading for each wiki section (config.yaml wiki.sections):
// partners -> "## Partners".
const sectionHeads = (vault) => Object.fromEntries(getConfig(vault).wiki.sections.map((s) => [String(s), `## ${String(s).charAt(0).toUpperCase()}${String(s).slice(1)}`]));
const UNSORTED = '### Not yet sorted';

function describe(text) {
  const name = ((text.match(/^name:\s*"?([^"\n]+)"?/m) || [])[1] || '').trim();
  const over = (text.split(/^## Overview\s*$/m)[1] || '').split(/^## /m)[0].replace(/\s+/g, ' ').trim();
  const first = (over.match(/^(.+?[.!?])(\s|$)/) || [, over])[1] || '';
  const d = (first || name).replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => b || a.split('/').pop()).trim();
  return d.length > 220 ? `${d.slice(0, 217)}…` : d;
}

// Insert lines for `rels` (wiki/<dir>/<slug>.md) that the index lacks. Returns the added rels.
function addToIndex(vault, rels) {
  const SECTION = sectionHeads(vault);
  const idx = path.join(vault, 'wiki', 'index.md');
  let lines = fs.readFileSync(idx, 'utf8').split('\n');
  const has = (rel) => lines.some((l) => l.includes(`[[${rel.replace(/\.md$/, '')}]]`));
  const added = [];
  for (const rel of rels) {
    const dir = rel.split('/')[1];
    const head = SECTION[dir];
    if (!head || has(rel) || !fs.existsSync(path.join(vault, rel))) continue;
    const line = `- [[${rel.replace(/\.md$/, '')}]] — ${describe(fs.readFileSync(path.join(vault, rel), 'utf8'))}`;
    let start = lines.findIndex((l) => l.trim() === head);
    if (start < 0) { lines.push('', head, ''); start = lines.length - 2; }
    let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    if (end < 0) end = lines.length;
    if (dir === 'people') {
      let sub = lines.findIndex((l, i) => i > start && i < end && l.trim() === UNSORTED);
      if (sub < 0) { lines.splice(end, 0, UNSORTED, ''); sub = end; end += 2; }
      // Insert after the last list line of the unsorted block.
      let at = sub + 1;
      while (at < end && (lines[at].startsWith('- ') || lines[at] === '') && !/^#{2,3} /.test(lines[at])) at++;
      while (at > sub + 1 && lines[at - 1] === '') at--;
      lines.splice(at, 0, line);
    } else {
      let at = end;
      while (at > start + 1 && lines[at - 1].trim() === '') at--;
      lines.splice(at, 0, line);
    }
    added.push(rel);
  }
  if (added.length) fs.writeFileSync(idx, lines.join('\n'));
  return added;
}

module.exports = { addToIndex, describe };
