// Linear Rescope, code-backed (decisions 7A, OV10). Builds
// linear/.initiative-scope.json, the set of projects the Linear sync covers.
//
//   scope = config.yaml sources.linear.scope: { initiative: <id> } or { team: <key> }
//           (no config: the root_id of the existing cache)
//
//   initiative:  list_projects(initiative: root) to exhaustion  -> N projects
//                get_initiative(includeSubInitiatives) down the tree -> initiatives
//                list_projects(initiative: child) per top-level child -> workstreams
//                CROSS-CHECK M = |union of the children's projects + the root's
//                own direct projects|. N and M are two independent counts.
//   team:        list_projects(team: key) to exhaustion -> N; no tree, no cross-check
//
//   guard:  every page read (no unfinished list) AND N >= 80% of the last good
//           scope. Otherwise nothing is written.
//   first:  no earlier scope -> staged; the owner confirms on a Your-move card
//           ("walked N; cross-check M"). A mismatch blocks with Retry only.
//   later:  guard passes and the cross-check found nothing the walk lacks ->
//           written without asking.

const fs = require('fs');
const path = require('path');
const { collect } = require('./buttons');
const { getConfig } = require('./config');
const { tool } = require('./connectors');

const FLOOR = 0.8;
const MAX_DEPTH = 8;

const scopeFile = (vault) => path.join(vault, 'linear', '.initiative-scope.json');
const stagedFile = (vault) => path.join(vault, '.bot', 'state', 'linear-scope-staged.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function scopeTarget(vault) {
  const sc = getConfig(vault).sources.linear.scope || {};
  if (sc.initiative) return { initiative: String(sc.initiative) };
  if (sc.team) return { team: String(sc.team) };
  const cache = readJson(scopeFile(vault));
  if (cache && cache.root_id) return { initiative: cache.root_id };
  if (cache && cache.team) return { team: cache.team };
  return null;
}

const listPage = (key) => (j) => (Array.isArray(j[key]) ? { items: j[key], next: j.hasNextPage ? j.cursor : null } : null);

async function walk(ctx, run, target) {
  const { vault } = ctx;
  const T = (n) => tool(vault, 'linear', n);
  const log = (s) => ctx.logLine(run, s);
  let cost = 0;
  const unfinished = [];
  const projFields = ['id', 'name'];

  if (target.team) {
    const p = await collect(ctx, run, T('list_projects'), [{ args: { team: target.team, includeArchived: true, limit: 50, fields: projFields } }], { pageOf: listPage('projects'), label: 'team projects', maxRounds: 6 });
    cost += p.cost; unfinished.push(...p.unfinished);
    const projects = [...new Map([...p.results.values()].flat().map((x) => [x.id, { id: x.id, name: x.name, workstreams: [] }])).values()];
    return { scope: { team: target.team, root_id: null, initiatives: [], projects, project_count: projects.length }, cross: null, unfinished, cost };
  }

  // 1. All projects under the root, one paged call.
  const root = target.initiative;
  const rp = await collect(ctx, run, T('list_projects'), [{ args: { initiative: root, includeArchived: true, limit: 50, fields: projFields } }], { pageOf: listPage('projects'), label: 'projects under the root', maxRounds: 6 });
  cost += rp.cost; unfinished.push(...rp.unfinished);
  const all = new Map([...rp.results.values()].flat().map((x) => [x.id, { id: x.id, name: x.name, workstreams: [] }]));
  log(`walked ${all.size} project(s) under the root`);

  // 2. The initiative tree, level by level. An initiative can hang off two
  // parents; visited ids stop loops.
  const initiatives = [];
  const seen = new Set();
  let level = [{ id: root, parent_id: null }];
  for (let depth = 0; level.length && depth < MAX_DEPTH; depth++) {
    const gi = await collect(ctx, run, T('get_initiative'), level.map((x) => ({ args: { query: x.id, includeSubInitiatives: true } })), { pageOf: (j) => (j && j.id ? { items: [j], next: null } : null), batch: 32, label: `initiatives, depth ${depth}` });
    cost += gi.cost; unfinished.push(...gi.unfinished);
    const next = [];
    for (const x of level) {
      const j = (gi.results.get(gi.keyOf({ query: x.id, includeSubInitiatives: true })) || [])[0];
      if (!j || seen.has(x.id)) continue;
      seen.add(x.id);
      initiatives.push({ id: x.id, name: j.name, parent_id: x.parent_id, depth });
      for (const s of j.subInitiatives || []) if (s && s.id && !seen.has(s.id)) next.push({ id: s.id, parent_id: x.id });
    }
    level = next;
  }
  log(`walked ${initiatives.length} initiative(s)`);

  // 3. Workstreams = the root's direct children. Their sub-trees label the
  // projects, and their union (+ the root's direct projects) is the cross-check.
  const children = initiatives.filter((i) => i.parent_id === root);
  const cp = await collect(ctx, run, T('list_projects'), children.map((c) => ({ args: { initiative: c.id, includeArchived: true, limit: 50, fields: projFields } })), { pageOf: listPage('projects'), label: 'workstream projects', maxRounds: 6 });
  cost += cp.cost; unfinished.push(...cp.unfinished);
  const projects0 = () => [...all.values()];
  const union = new Map(); // id -> { name, from }
  for (const c of children) {
    for (const x of cp.results.get(cp.keyOf({ initiative: c.id, includeArchived: true, limit: 50, fields: projFields })) || []) {
      if (!union.has(x.id)) union.set(x.id, { name: x.name, from: c.name });
      if (all.has(x.id)) all.get(x.id).workstreams.push(c.name);
    }
  }
  const gr = await collect(ctx, run, T('get_initiative'), [{ args: { query: root, includeProjects: true } }], { pageOf: (j) => (j && j.id ? { items: [j], next: null } : null), label: 'root direct projects' });
  cost += gr.cost; unfinished.push(...gr.unfinished);
  const rj = [...gr.results.values()].flat()[0] || {};
  // get_initiative returns project UUIDs where list_projects returns short
  // ids (P-TEAM-123), measured 2026-10-09; match those by name.
  const byName = new Map(projects0().map((p) => [p.name, p.id]));
  for (const x of rj.projects || []) {
    if (!x || !x.id) continue;
    const id = all.has(x.id) ? x.id : byName.get(x.name) || x.id;
    if (!union.has(id)) union.set(id, { name: x.name, from: '(root, direct)' });
  }
  const projects = [...all.values()];
  // What each count has that the other lacks, for the card and the log.
  const onlyUnion = [...union].filter(([id]) => !all.has(id)).map(([id, v]) => ({ id, ...v }));
  const onlyWalk = projects.filter((p) => !union.has(p.id)).map((p) => ({ id: p.id, name: p.name }));
  if (onlyUnion.length) log(`in the workstreams but not under the root: ${onlyUnion.length}, e.g. ${onlyUnion.slice(0, 4).map((x) => `${x.name} (${x.from})`).join('; ')}`);
  if (onlyWalk.length) log(`under the root but in no workstream: ${onlyWalk.length}, e.g. ${onlyWalk.slice(0, 4).map((x) => x.name).join('; ')}`);
  return {
    scope: { root_id: root, initiatives, projects, project_count: projects.length },
    cross: { walked: projects.length, union: union.size, directKnown: Array.isArray(rj.projects), onlyUnion: onlyUnion.slice(0, 50), onlyWalk: onlyWalk.slice(0, 50) },
    unfinished, cost,
  };
}

// The rescope bot. body.accept = take the staged scope; body.retry = walk again.
// walkFn is for tests (a stand-in walk); the app always uses walk().
async function runRescope(run, ctx, body = {}, walkFn = walk) {
  const { vault, logLine, finish } = ctx;
  const log = (s) => logLine(run, s);
  const prev = readJson(scopeFile(vault));
  if (body.accept) {
    const st = readJson(stagedFile(vault));
    if (!st || st.blocked) return finish(run, 'error', 'nothing to accept: no staged scope, or it was blocked. Press Retry.');
    writeScope(vault, st.scope);
    fs.rmSync(stagedFile(vault), { force: true });
    return finish(run, 'ok', `scope set: ${st.scope.project_count} project(s), ${st.scope.initiatives.length} initiative(s)`);
  }
  const target = scopeTarget(vault);
  if (!target) return finish(run, 'error', 'set sources.linear.scope (an initiative ID or a team key) in config.yaml first');
  log(`rescope ${target.team ? `team ${target.team}` : `initiative ${target.initiative}`}`);
  const r = await walkFn(ctx, run, target);
  const n = r.scope.project_count;
  const prevN = prev && prev.project_count;
  const problems = [];
  if (r.unfinished.length) problems.push(`${r.unfinished.length} list(s) never finished (pages not exhausted)`);
  if (!n) problems.push('the walk found no projects');
  if (prevN && n < FLOOR * prevN) problems.push(`${n} project(s) is under 80% of the last good scope (${prevN})`);
  // The check exists to catch a walk that MISSED projects (stopped paging):
  // so it blocks only when the second count found projects the walk lacks.
  // Projects the walk has and no workstream lists are real and kept (logged).
  const mismatch = r.cross && r.cross.directKnown && r.cross.onlyUnion.length > 0;
  const crossText = r.cross ? `walked ${n}; cross-check ${r.cross.union}${r.cross.directKnown ? '' : ' (root direct projects unknown)'}${r.cross.onlyUnion.length ? `, ${r.cross.onlyUnion.length} missing from the walk` : ''}${r.cross.onlyWalk.length ? `, ${r.cross.onlyWalk.length} in no workstream` : ''}` : `walked ${n}`;
  log(crossText);
  if (problems.length) {
    writeStaged(vault, { scope: r.scope, cross: r.cross, blocked: true, problems });
    return finish(run, 'error', `scope NOT changed: ${problems.join('; ')}. Press Retry.`, { kind: 'rescope', blocked: true, problems }, r.cost);
  }
  if (mismatch) {
    writeStaged(vault, { scope: r.scope, cross: r.cross, blocked: true, problems: [crossText] });
    return finish(run, 'error', `scope NOT changed: the two counts disagree (${crossText}). Press Retry.`, { kind: 'rescope', blocked: true }, r.cost);
  }
  if (!prev) {
    writeStaged(vault, { scope: r.scope, cross: r.cross, blocked: false });
    return finish(run, 'warn', `first scope staged: ${crossText}, ${r.scope.initiatives.length} initiative(s). Confirm it on Today.`, { kind: 'rescope', staged: true }, r.cost);
  }
  writeScope(vault, r.scope);
  finish(run, 'ok', `scope refreshed: ${crossText} (was ${prevN})`, { cross: r.cross }, r.cost);
}

function writeScope(vault, scope) {
  fs.rmSync(stagedFile(vault), { force: true }); // a new good scope ends any staged one
  fs.mkdirSync(path.dirname(scopeFile(vault)), { recursive: true });
  fs.writeFileSync(scopeFile(vault), `${JSON.stringify({ ...scope, refreshed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }, null, 2)}\n`);
}

function writeStaged(vault, st) {
  fs.mkdirSync(path.dirname(stagedFile(vault)), { recursive: true });
  fs.writeFileSync(stagedFile(vault), JSON.stringify({ ...st, at: new Date().toISOString() }, null, 2));
}

const staged = (vault) => readJson(stagedFile(vault));
// Weekly: the Morning run rescopes when the cache is older than 7 days.
function scopeAgeDays(vault) {
  const c = readJson(scopeFile(vault));
  const t = c && Date.parse(c.refreshed_at);
  return Number.isFinite(t) ? (Date.now() - t) / 864e5 : Infinity;
}

module.exports = { runRescope, walk, scopeTarget, staged, scopeAgeDays, FLOOR };
