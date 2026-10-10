// The kit's block in the vault's CLAUDE.md (decision 2A). The kit owns the
// text between the markers; the owner owns everything outside them.
//
//   <!-- kit:begin v1 sha=<12 hex> -->
//   ...rendered from templates/vault/CLAUDE.md + config.yaml...
//   <!-- kit:end -->
//
// sha is the hash of the text between the markers as the kit last wrote it.
// If the text no longer matches, the owner edited inside the block, and an
// update stops instead of overwriting that edit.
//
//   render(vault)            -> the block body for this vault
//   apply(text, body)        -> { status, text, diff }
//                               status: inserted | updated | unchanged | edited-inside
//   update(vault, {write})   -> apply() on <vault>/CLAUDE.md; writes only if asked

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getConfig } = require('./config');
const { KIT_DIR } = require('./kit');

const VERSION = 1;
const TEMPLATE = path.join(KIT_DIR, 'templates', 'vault', 'CLAUDE.md');
const BEGIN = /<!-- kit:begin v(\d+) sha=([0-9a-f]{12}) -->\n/;
const END = '<!-- kit:end -->';

const sha12 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

function linearScope(vault, cfg) {
  const sc = cfg.sources.linear.scope || {};
  if (sc.initiative) return `the Linear initiative \`${sc.initiative}\` and its whole sub-tree of initiatives and projects`;
  if (sc.team) return `the Linear team \`${sc.team}\``;
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(vault, 'linear', '.initiative-scope.json'), 'utf8'));
    if (cache.root_id) return `the Linear initiative \`${cache.root_id}\` and its whole sub-tree of initiatives and projects`;
  } catch {}
  return 'the scope set in `linear/.initiative-scope.json` (run Rescope in the app to build it)';
}

function values(vault) {
  const c = getConfig(vault);
  const w = (k) => String(c.sources[k].window_days);
  return {
    APP_PORT: String(require('./install').port()),
    CLI: path.join(KIT_DIR, 'app', 'bin', 'second-brain'),
    KIT_DIR,
    KIT_SCRIPTS: path.join(KIT_DIR, 'scripts'),
    LINEAR_SCOPE: linearScope(vault, c),
    SLACK_USER_ID: c.owner.slack_user_id || 'YOUR_SLACK_USER_ID',
    SLACK_WINDOW: w('slack'), LINEAR_WINDOW: w('linear'), NOTION_WINDOW: w('notion'),
    GCAL_WINDOW: w('gcal'), GDRIVE_WINDOW: w('gdrive'), GMAIL_WINDOW: w('gmail'),
    WIKI_SECTIONS: c.wiki.sections.join(', '),
    TAG_NAMESPACES: c.tags.namespaces.join(', '),
    PROMOTION_MIN_SOURCES: String(c.wiki.promotion.default_min_sources),
    PERSON_EXTERNAL_MIN: String(c.wiki.promotion.person_external_min),
  };
}

function render(vault) {
  const v = values(vault);
  const body = fs.readFileSync(TEMPLATE, 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in v ? v[k] : m));
  const left = body.match(/\{\{[A-Z_]+\}\}/g);
  if (left) throw new Error(`kit block template has unknown placeholders: ${[...new Set(left)].join(', ')}`);
  return body.endsWith('\n') ? body : `${body}\n`;
}

const wrap = (body) => `<!-- kit:begin v${VERSION} sha=${sha12(body)} -->\n${body}${END}\n`;

// Where the block sits in a file, or null.
function locate(text) {
  const m = BEGIN.exec(text);
  if (!m) return null;
  const start = m.index, bodyStart = start + m[0].length;
  const endAt = text.indexOf(END, bodyStart);
  if (endAt < 0) return { broken: true };
  let end = endAt + END.length;
  if (text[end] === '\n') end++;
  return { start, end, version: Number(m[1]), sha: m[2], body: text.slice(bodyStart, endAt) };
}

// opts.ownerHeader: placed above an existing file's text on first insert, so a
// reader knows that text is the owner's, below the kit block.
function apply(text, body, opts = {}) {
  const at = locate(text || '');
  if (at && at.broken) return { status: 'edited-inside', text, diff: '', reason: 'the kit:end marker is missing' };
  if (!at) {
    // First time: the block goes on top; the owner's text stays below it, as is.
    const rest = text ? `\n${opts.ownerHeader ? `${opts.ownerHeader}\n\n` : ''}${text}` : '\n<!-- Your own notes go below this line. The app never changes them. -->\n';
    return { status: 'inserted', text: `${wrap(body)}${rest}`, diff: lineDiff('', body) };
  }
  if (sha12(at.body) !== at.sha) {
    return { status: 'edited-inside', text, diff: lineDiff(at.body, body), reason: 'the text inside the kit block was edited by hand. Move your edit below kit:end, then update again' };
  }
  if (at.body === body && at.version === VERSION) return { status: 'unchanged', text, diff: '' };
  return { status: 'updated', text: text.slice(0, at.start) + wrap(body) + text.slice(at.end), diff: lineDiff(at.body, body) };
}

// A compact line diff (LCS), "- old" / "+ new" lines only.
function lineDiff(a, b) {
  const x = a ? a.split('\n') : [], y = b ? b.split('\n') : [];
  if (x.length * y.length > 4e6) return `(${x.length} → ${y.length} lines)`;
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(`- ${x[i++]}`); else out.push(`+ ${y[j++]}`);
  }
  while (i < n) out.push(`- ${x[i++]}`);
  while (j < m) out.push(`+ ${y[j++]}`);
  return out.join('\n');
}

function update(vault, { write = false, ownerHeader } = {}) {
  const file = path.join(vault, 'CLAUDE.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const r = apply(text, render(vault), { ownerHeader });
  if (write && (r.status === 'inserted' || r.status === 'updated')) fs.writeFileSync(file, r.text);
  return { ...r, file };
}

module.exports = { render, apply, update, locate, lineDiff, VERSION, TEMPLATE };
