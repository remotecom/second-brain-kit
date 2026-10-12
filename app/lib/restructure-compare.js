// The restructure compare view (T24): what a staged split does to a page,
// built by CODE from the three staged files (old.md, hub.md, history.md).
// No model call. For each section of the old page: where it goes, its size,
// and why (the rule in restructure-bot.js that put it there). Plus the hub's
// new summary sections, and the owner's comments, which a re-stage passes to
// the model.

const fs = require('fs');
const path = require('path');
const { sections, classify } = require('./restructure-bot');
const { splitFrontmatter } = require('./ingest');

const DIR = (vault, slug) => path.join(vault, '.bot', 'restructure', slug);
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const SLUG = /^[\w.-]+$/;

const WHY = {
  title: 'The page title: stays on the hub.',
  reference: 'Reference content (no date in its heading): stays on the hub, word for word.',
  history: 'A dated or logged section: moves word for word to the history page, in date order.',
  tail: 'Related / Sources: merged into one list on each page; every line kept once.',
  new: 'New summary written by Opus from the whole page. Every line links a raw file or a history heading; lines without one were dropped.',
};

function load(vault, slug) {
  if (!SLUG.test(slug)) throw new Error('bad slug');
  const d = DIR(vault, slug);
  const old = read(path.join(d, 'old.md')), hub = read(path.join(d, 'hub.md')), history = read(path.join(d, 'history.md')), report = read(path.join(d, 'report.md'));
  if (!old || !hub || !history || !report) throw new Error('this restructure is not fully staged');
  const rel = (report.match(/^# Restructure: (\S+)/m) || [])[1];
  return { d, old, hub, history, report, rel };
}

function compare(vault, slug) {
  const { old, hub, history, rel, d } = load(vault, slug);
  const oldSecs = classify(sections(splitFrontmatter(old).body));
  const hubHeads = new Set(sections(splitFrontmatter(hub).body).map((s) => s.head));
  const hist = sections(splitFrontmatter(history).body);
  const histHeads = hist.map((s) => s.head).filter(Boolean);
  const bytes = (t) => Buffer.byteLength(t, 'utf8');
  const rows = oldSecs.filter((s) => s.text.trim()).map((s) => {
    const goes = s.kind === 'history' ? 'history' : s.kind === 'tail' ? 'merged' : 'hub';
    // A moved heading may have been suffixed " (2)" to keep anchors unique.
    const at = goes === 'history' ? histHeads.find((h) => h === s.head || h.startsWith(`${s.head} (`)) : null;
    return { i: s.i, head: s.head === null ? '(title)' : s.head, kind: s.kind, goes, bytes: bytes(s.text), why: WHY[s.kind], at };
  });
  const hubNew = sections(splitFrontmatter(hub).body).filter((s) => /^(Current state|Timeline|Open questions)/.test(s.head || '') && !oldSecs.some((o) => o.head === s.head));
  const fresh = hubNew.map((s) => ({ i: `new-${s.i}`, head: s.head, kind: 'new', goes: 'hub', bytes: bytes(s.text), why: WHY.new }));
  let comments = {};
  try { comments = JSON.parse(fs.readFileSync(path.join(d, 'comments.json'), 'utf8')); } catch {}
  return {
    rel, histRel: rel.replace(/\.md$/, '-history.md'),
    sizes: { old: bytes(old), hub: bytes(hub), history: bytes(history) },
    stays: rows.filter((r) => r.goes === 'hub').reduce((a, r) => a + r.bytes, 0),
    moves: rows.filter((r) => r.goes === 'history').reduce((a, r) => a + r.bytes, 0),
    added: fresh.reduce((a, r) => a + r.bytes, 0),
    sections: [...fresh, ...rows], comments, hubHas: [...hubHeads].length,
  };
}

// One section, before and after.
function section(vault, slug, i) {
  const { old, hub, history } = load(vault, slug);
  if (String(i).startsWith('new-')) {
    const s = sections(splitFrontmatter(hub).body).find((x) => `new-${x.i}` === String(i));
    if (!s) throw new Error('no such section');
    return { before: '', after: s.text, where: 'new on the hub' };
  }
  const s = classify(sections(splitFrontmatter(old).body)).find((x) => x.i === Number(i));
  if (!s) throw new Error('no such section');
  const target = s.kind === 'history' ? history : hub;
  const tsecs = sections(splitFrontmatter(target).body);
  if (s.head === null) { const h = tsecs.find((x) => x.head === null); return { before: s.text, after: h ? h.text : '', where: 'hub', same: !!h && h.text.includes(s.text.trim()), missing: [] }; }
  const t = tsecs.find((x) => x.head && (x.head === s.head || x.head.startsWith(`${s.head} (`)));
  const after = t ? t.text : '';
  // The lines of the old section that are not in the new text (should be none).
  const have = new Set(target.split('\n'));
  const missing = s.text.split('\n').filter((l) => l.trim() && !have.has(l) && !/^## /.test(l));
  return { before: s.text, after, where: s.kind === 'history' ? 'history page' : s.kind === 'tail' ? 'merged list' : 'hub', same: t ? t.text.trim() === s.text.trim() : false, missing };
}

function saveComment(vault, slug, head, text) {
  const { d } = load(vault, slug);
  const f = path.join(d, 'comments.json');
  let c = {}; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const t = String(text || '').trim().slice(0, 2000);
  if (t) c[String(head).slice(0, 200)] = t; else delete c[String(head).slice(0, 200)];
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
  return c;
}

module.exports = { compare, section, saveComment, WHY };
