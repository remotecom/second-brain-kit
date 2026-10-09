// Route ingest entries to the wiki page they mostly belong to, so one model
// call sees every entry about Acme (say) across all the days in the delta and
// reads the Acme page once. Grouping by raw file instead made each part re-read
// the same big pages, and split a moving fact (Sept 30 → Oct 9 → Oct 22)
// across parts that never saw each other (2026-10-01).
//
// Mechanical, no model: each wiki page contributes "terms" (its name, slug,
// entity tags); an entry scores a page by the rare terms it contains (IDF, so
// the company's own name doesn't pull everything to one page). The top page is the
// entry's primary. Entries with no clear primary are grouped by source class.

const fs = require('fs');
const path = require('path');
const { readList } = require('./config');

const TYPE_WEIGHT = { people: 0.15, concepts: 0.6, principles: 0.3, workflows: 0.6, problems: 0.7 };
const ENTITY_TAG = /^(partner|customer|integrator|system)\/(.+)$/;
// Generic stop words. Words that are common only in one install (the company
// name, internal system names) go in config.yaml ingest.stop_words.
const STOP = new Set(['api', 'the', 'and', 'for', 'sdk', 'mcp', 'wiki', 'notes', 'sync', 'team', 'product', 'payroll', 'contractor', 'contractors', 'integration', 'integrations', 'partner', 'partners', 'customer', 'customers', 'phase', 'launch', 'v1', 'v2']);
// How much a matched term counts, by how tightly it belongs to the page.
const TIER = { own: 1, tag: 0.6, word: 0.35, ticket: 1 };

function walk(dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out); else if (d.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// A page's terms, each with a tier: "own" = its name or slug (partners/acme is
// "acme"), "tag" = an entity tag it carries (every Acme initiative has
// partner/acme), "word" = a word inside its slug, "ticket" = a ticket ID it cites.
function termsOf(rel, text) {
  const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  const name = ((fm.match(/^name:\s*"?([^"\n]+)"?/m) || [])[1] || '').replace(/\(.*?\)/g, '').trim();
  const slug = path.basename(rel, '.md');
  const terms = new Map(); // term -> tier (the tightest wins)
  const rankOf = (t) => ['own', 'ticket', 'tag', 'word'].indexOf(t);
  const add = (t, tier) => {
    t = String(t).toLowerCase().replace(/[-_]+/g, ' ').trim();
    if (t.length < 3 || STOP.has(t) || localStop.has(t)) return;
    if (!terms.has(t) || rankOf(tier) < rankOf(terms.get(t))) terms.set(t, tier);
  };
  const person = rel.startsWith('wiki/people/');
  add(name, 'own'); add(slug, 'own');
  if (person) { const w = name.split(/\s+/); if (w.length >= 2) add(`${w[0]} ${w[1]}`, 'own'); }
  for (const m of (fm.match(/^aliases:\s*\[(.*)\]/m) || [, ''])[1].split(',')) add(m.replace(/["']/g, ''), 'own');
  for (const m of fm.matchAll(/^\s*-\s*([a-z]+\/[a-z0-9-]+)\s*$/gm)) { const t = m[1].match(ENTITY_TAG); if (t) add(t[2], 'tag'); }
  if (!person) for (const w of slug.split('-')) add(w, 'word');
  for (const m of text.matchAll(/\b([A-Z]{2,6}-\d{2,5})\b/g)) add(m[1], 'ticket');
  return terms;
}

let localStop = new Set();

function buildIndex(vault) {
  localStop = new Set(readList(vault, 'ingest', 'stop_words').map((w) => w.toLowerCase()));
  const root = path.join(vault, 'wiki');
  const pages = [];
  for (const abs of walk(root)) {
    const rel = path.relative(vault, abs);
    if (rel === 'wiki/index.md' || rel === 'wiki/log.md') continue;
    const dir = rel.split('/')[1];
    pages.push({ rel, weight: TYPE_WEIGHT[dir] || 1, person: dir === 'people', terms: termsOf(rel, fs.readFileSync(abs, 'utf8')) });
  }
  return pages;
}

const CHANNEL_BOOST = 8;
const CHANNEL_STOP = new Set(['proj', 'ext', 'internal', 'team', 'dev', 'help', 'eng', 'product', 'issues', 'alerts', 'partnerships', 'partner', 'partners', 'opp', 'general', 'announcements', 'integrations', 'com', 'staging']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Returns entries annotated with { primary, related[] }.
function route(vault, entries) {
  const pages = buildIndex(vault);
  const byTerm = new Map(); // term -> [{ page, tier }]
  for (const p of pages) for (const [t, tier] of p.terms) { if (!byTerm.has(t)) byTerm.set(t, []); byTerm.get(t).push({ page: p, tier }); }
  const lower = entries.map((e) => e.text.toLowerCase());
  const hits = lower.map(() => new Set());
  const df = new Map();
  for (const [t] of byTerm) {
    const re = new RegExp(`(^|[^a-z0-9])${esc(t)}([^a-z0-9]|$)`);
    let n = 0;
    lower.forEach((txt, i) => { if (txt.includes(t) && re.test(txt)) { hits[i].add(t); n++; } });
    if (n) df.set(t, n);
  }
  const N = entries.length;
  const bump = (score, rel, v) => score.set(rel, (score.get(rel) || 0) + v);
  // Owners of a term at its tightest tier: for "acme" that is partners/acme
  // (own), not the dozen acme-* pages (word) or everything tagged partner/acme.
  const tightest = (t) => {
    const os = byTerm.get(t) || [];
    for (const tier of ['own', 'ticket', 'tag', 'word']) { const xs = os.filter((o) => o.tier === tier); if (xs.length) return xs; }
    return [];
  };
  return entries.map((e, i) => {
    const score = new Map();
    for (const t of hits[i]) {
      const idf = Math.log(1 + N / df.get(t));
      const owners = byTerm.get(t);
      for (const o of owners) bump(score, o.page.rel, (idf * o.page.weight * TIER[o.tier]) / owners.length);
    }
    // The channel (or DM partner) is the strongest signal a Slack entry has:
    // #proj-acme is Acme, #c_globex is Globex, #ext-yourco-initech is Initech.
    const where = (e.text.match(/^- \*\*[^*]+\*\* · (#[\w-]+|DM with [^\[\n]+)/m) || [])[1];
    if (where && where.startsWith('#')) {
      for (const w of where.slice(1).toLowerCase().split(/[-_]+/).filter((x) => x.length >= 3 && !CHANNEL_STOP.has(x) && !localStop.has(x))) {
        const os = tightest(w).filter((o) => !o.page.person);
        for (const o of os) bump(score, o.page.rel, (CHANNEL_BOOST * o.page.weight) / os.length);
      }
    } else if (where) {
      // A DM is about its topic first; the person page is the fallback home.
      for (const o of tightest(where.slice(8).trim().toLowerCase()).filter((x) => x.page.person)) bump(score, o.page.rel, 0.8);
    }
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    const primary = top && top[1] >= 1.5 ? top[0] : null;
    return { ...e, primary, related: ranked.slice(primary ? 1 : 0, 4).filter(([, s]) => s >= 1).map(([r]) => r) };
  });
}

// Group routed entries by primary page and pack into parts of <= maxBytes.
// A group bigger than one part spans several parts; parts of one group carry
// the same primary, and the runner never runs two of them at once. Small
// groups share a part. Within a group entries keep time order (path, then
// position), so later facts come after earlier ones.
function groupParts(routed, maxBytes, rank) {
  const groups = new Map();
  routed.forEach((e, i) => {
    // No page yet: cluster by what the raw itself says it belongs to.
    const fmv = (k) => ((e.text.match(new RegExp(`^${k}:\\s*"?([^"\\n]+)"?`, 'm')) || [])[1] || '').trim();
    const where = (e.text.match(/^- \*\*[^*]+\*\* · (#[\w-]+)/m) || [])[1];
    const key = e.primary || `misc:${e.rel.split('/')[0]}:${fmv('project') || fmv('parent_database') || where || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...e, order: i });
  });
  const list = [...groups.entries()].map(([key, es]) => ({
    key, es: es.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.order - b.order)),
    size: es.reduce((n, e) => n + e.text.length, 0),
    rank: Math.min(...es.map((e) => rank(e.rel))),
  }));
  // Most important source class first, then the biggest clusters.
  list.sort((a, b) => a.rank - b.rank || b.size - a.size);
  const parts = [];
  let open = null; // a part collecting small groups
  for (const g of list) {
    if (g.size > maxBytes / 2) {
      let cur = [];
      for (const e of g.es) {
        if (cur.length && cur.reduce((n, x) => n + x.text.length, 0) + e.text.length > maxBytes) { parts.push({ entries: cur, primaries: [g.key] }); cur = []; }
        cur.push(e);
      }
      const rest = cur.reduce((n, x) => n + x.text.length, 0);
      if (rest > maxBytes / 2) { parts.push({ entries: cur, primaries: [g.key] }); continue; }
      g.es = cur; g.size = rest; // a small remainder packs with other small groups
    }
    if (!open || open.size + g.size > maxBytes) { open = { entries: [], primaries: [], size: 0 }; parts.push(open); }
    open.entries.push(...g.es); open.primaries.push(g.key); open.size += g.size;
  }
  return parts.map((p) => ({ entries: p.entries.map((e, i) => ({ ...e, id: `E${i + 1}` })), primaries: p.primaries.filter((k) => !k.startsWith('misc:')) }));
}

module.exports = { route, groupParts, buildIndex, termsOf };
