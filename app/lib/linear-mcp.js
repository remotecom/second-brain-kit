// Linear sync through the claude.ai Linear connector. Same pattern as Slack:
// the runner decides every call, haiku only presses the buttons, and code
// renders the raw files from the connector's JSON. Scope: the initiative tree
// in linear/.initiative-scope.json, split into tiers by config.yaml
// (lib/tiers.js): deep projects get every issue + comment, link-only ones a
// row in linear/catalog.md. Issues assigned to the owner are deep anywhere.
//
//   list    issues per in-scope project + assignee=me   (ids only)
//           projects under the root initiative           (updated in range)
//           documents updated in range                   (content included)
//           every initiative in the tree                 (get_initiative)
//   detail  get_issue (full description; lists truncate) + list_comments
//           get_project (full description)
//   render  linear/{issues,projects,docs,initiatives}/*.md in the existing format
//   gate    sync.verify ─▶ sync.commit (hash skip) ─▶ watermark if complete

const fs = require('fs');
const path = require('path');
const { collect } = require('./buttons');
const { verify, commit } = require('./sync');
const { readPending, writePending } = require('./ledger');
const { linearTiers } = require('./tiers');

const T = (name) => `mcp__claude_ai_Linear__${name}`;
const DAY = 86400000;
const WINDOW_DAYS = 4;

const q = (v) => (v === null || v === undefined || v === '' ? 'null' : JSON.stringify(String(v)));
const iso = (ms) => new Date(ms).toISOString();

// The connector returns people as a string, or an object with name /
// displayName / email depending on the call.
const personName = (x) => (!x ? '' : typeof x === 'string' ? x : x.name || x.displayName || x.email || '');

function frontmatter(obj) {
  return ['---', ...Object.entries(obj).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`), '---'].join('\n');
}

function renderComments(comments, baseUrl) {
  if (!comments.length) return '';
  const byParent = new Map();
  for (const c of comments) {
    const k = c.parentId || 'root';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(c);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const out = ['', '## Comments'];
  const walk = (parentKey, depth) => {
    for (const c of byParent.get(parentKey) || []) {
      const pad = '  '.repeat(depth);
      const who = (c.author && c.author.name) || 'Unknown';
      out.push(depth === 0
        ? `${pad}- **${who}** · ${c.createdAt} [↗](${baseUrl}#comment-${c.id})`
        : `${pad}- **${who}** · ${c.createdAt}`);
      out.push(...String(c.body || '').split('\n').map((l) => `${pad}  ${l}`));
      walk(c.id, depth + 1);
    }
  };
  walk('root', 0);
  return out.join('\n');
}

async function syncLinearMcp(run, ctx) {
  const { vault, logLine, finish, src } = ctx;
  const log = (s) => logLine(run, s);
  const scopePath = path.join(vault, 'linear', '.initiative-scope.json');
  let scope;
  try { scope = JSON.parse(fs.readFileSync(scopePath, 'utf8')); } catch { return finish(run, 'error', 'linear/.initiative-scope.json missing or unreadable; run a rescope first'); }
  if (!scope.projects || scope.projects.length < 150) return finish(run, 'error', `scope looks truncated (${(scope.projects || []).length} projects, expected ~200); not syncing`);

  // Range: MIN(4-day window, watermark), per the spec.
  const now = Date.now();
  const windowStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - (WINDOW_DAYS - 1) * DAY;
  let wm = null;
  try { wm = Date.parse(fs.readFileSync(path.join(vault, 'linear', '.last-sync'), 'utf8').trim()); } catch {}
  const since = Number.isFinite(wm) ? Math.min(windowStart, wm) : windowStart;
  const threshold = iso(since);
  log(`updated since ${threshold.slice(0, 16)}Z · ${scope.projects.length} projects, ${scope.initiatives.length} initiatives in scope · haiku presses buttons, runner writes`);
  let cost = 0;
  const unfinished = [];
  const listPage = (key) => (j) => (Array.isArray(j[key]) ? { items: j[key], next: j.hasNextPage ? j.cursor : null } : null);

  // Depth tiers (config.yaml linear.deep_initiatives): deep projects get
  // every issue + comment; link-only ones only a catalog row.
  let tiers;
  try { tiers = linearTiers(vault, scope); } catch (e) { return finish(run, 'error', e.message); }
  if (tiers.configured) log(`tiers: ${tiers.deepProjects.length} deep project(s), ${tiers.linkProjects.length} link-only (${tiers.linkWorkstreams.map((w) => w.name).join(', ')})`);

  // 1. Issue ids: one call per DEEP project, plus assigned-to-me (any tier).
  const issueJobs = [
    ...tiers.deepProjects.map((p) => ({ args: { project: p.id, updatedAt: threshold, includeArchived: true, limit: 250, fields: ['id', 'updatedAt'] } })),
    { args: { assignee: 'me', updatedAt: threshold, includeArchived: true, limit: 250, fields: ['id', 'updatedAt'] } },
  ];
  const iss = await collect(ctx, run, T('list_issues'), issueJobs, { pageOf: listPage('issues'), batch: 40, label: 'issue lists' });
  cost += iss.cost; unfinished.push(...iss.unfinished);
  const listFailed = [...iss.unfinished];
  const pendingIn = readPending(vault, 'linear');
  const issueIds = [...new Set([...[...iss.results.values()].flat().map((i) => i.id), ...pendingIn])];
  log(`${issueIds.length} issue(s) updated in range${pendingIn.length ? ` (incl. ${pendingIn.length} pending from an earlier run)` : ''}`);

  // 2. Projects, documents, initiatives.
  const projFields = ['id', 'uuid', 'name', 'url', 'createdAt', 'updatedAt', 'completedAt', 'canceledAt', 'lead', 'leadTeam', 'status', 'initiatives'];
  const prj = await collect(ctx, run, T('list_projects'), [{ args: { initiative: scope.root_id, updatedAt: threshold, includeArchived: true, limit: 50, fields: projFields } }], { pageOf: listPage('projects'), label: 'project list' });
  cost += prj.cost; unfinished.push(...prj.unfinished); listFailed.push(...prj.unfinished);
  // list_projects ignores orderBy (spec, 2026-09-21), so filter client-side.
  const projects = [...prj.results.values()].flat().filter((p) => p.updatedAt >= threshold && (tiers.isDeepProject(p.id) || tiers.isDeepProject(p.name)));

  // Link-only catalog: every project in the link-only workstreams, any date.
  const catFields = ['id', 'name', 'url', 'updatedAt', 'status', 'lead', 'targetDate'];
  const cat = tiers.configured
    ? await collect(ctx, run, T('list_projects'), tiers.linkWorkstreams.map((w) => ({ args: { initiative: w.id, includeArchived: true, limit: 50, fields: catFields } })), { pageOf: listPage('projects'), label: 'catalog' })
    : { results: new Map(), unfinished: [], cost: 0, keyOf: () => '' };
  cost += cat.cost; unfinished.push(...cat.unfinished); listFailed.push(...cat.unfinished);

  const docFields = ['id', 'title', 'content', 'url', 'createdAt', 'updatedAt', 'archivedAt', 'creator', 'updatedBy', 'project', 'initiative', 'team', 'issue'];
  const docs0 = await collect(ctx, run, T('list_documents'), [{ args: { updatedAt: threshold, limit: 100, fields: docFields } }], { pageOf: listPage('documents'), label: 'document list' });
  cost += docs0.cost; unfinished.push(...docs0.unfinished); listFailed.push(...docs0.unfinished);
  const scopeNames = new Set(scope.projects.map((p) => p.name));
  const initIds = new Set(scope.initiatives.map((i) => i.id));
  const scopeIds = new Set(scope.projects.map((p) => p.id));
  const swept = [...docs0.results.values()].flat().filter((d) => (d.project && (scopeIds.has(d.project.id) || scopeNames.has(d.project.name)) && (tiers.isDeepProject(d.project.id) || tiers.isDeepProject(d.project.name))) || (d.initiative && initIds.has(d.initiative.id) && tiers.isDeepInitiative(d.initiative.id)));
  const deepInitiatives = scope.initiatives.filter((i) => tiers.isDeepInitiative(i.id));
  // Spec pass 2: documents pinned to each initiative in the tree, no date
  // filter (hash-skip keeps unchanged ones from being rewritten).
  const pin = await collect(ctx, run, T('list_documents'), deepInitiatives.map((i) => ({ args: { initiativeId: i.id, limit: 50, fields: docFields } })), { pageOf: listPage('documents'), batch: 32, label: 'pinned docs' });
  cost += pin.cost; unfinished.push(...pin.unfinished); listFailed.push(...pin.unfinished);
  const docs = [...new Map([...swept, ...[...pin.results.values()].flat()].map((d) => [d.id, d])).values()];

  const ini = await collect(ctx, run, T('get_initiative'), deepInitiatives.map((i) => ({ args: { query: i.id } })), { pageOf: (j) => (j && j.id ? { items: [j], next: null } : null), batch: 32, label: 'initiatives' });
  cost += ini.cost; unfinished.push(...ini.unfinished); listFailed.push(...ini.unfinished);
  const initiatives = [...ini.results.values()].flat().filter((i) => (i.updatedAt || '') >= threshold);
  log(`${projects.length} project(s), ${docs.length} in-scope doc(s), ${initiatives.length} initiative(s) updated in range`);

  // 3. Details: full issue + comments, full project description.
  const gi = await collect(ctx, run, T('get_issue'), issueIds.map((id) => ({ args: { id } })), { pageOf: (j) => (j && j.id ? { items: [j], next: null } : null), batch: 25, label: 'get_issue' });
  const lc = await collect(ctx, run, T('list_comments'), issueIds.map((id) => ({ args: { issueId: id, limit: 250 } })), { pageOf: listPage('comments'), batch: 25, label: 'comments' });
  const gp = await collect(ctx, run, T('get_project'), projects.map((p) => ({ args: { query: p.id } })), { pageOf: (j) => (j && (j.id || j.name) ? { items: [j], next: null } : null), batch: 25, label: 'get_project' });
  cost += gi.cost + lc.cost + gp.cost; unfinished.push(...gi.unfinished, ...lc.unfinished, ...gp.unfinished); listFailed.push(...gp.unfinished);

  // 4. Render.
  const files = new Map();
  let maxUpdated = wm || 0;
  const bump = (t) => { const ms = Date.parse(t); if (Number.isFinite(ms) && ms > maxUpdated) maxUpdated = ms; };
  const projectInfo = new Map(scope.projects.map((p) => [p.name, p]));

  for (const id of issueIds) {
    const issue = (gi.results.get(gi.keyOf({ id })) || [])[0];
    if (!issue) continue;
    // Comments never fetched: leave the issue for the next run. Writing it
    // without a Comments section would claim it has none.
    if (!lc.results.has(lc.keyOf({ issueId: id, limit: 250 }))) continue;
    const comments = lc.results.get(lc.keyOf({ issueId: id, limit: 250 }));
    bump(issue.updatedAt);
    const assignee = typeof issue.assignee === 'string' ? issue.assignee : (issue.assignee && issue.assignee.name) || null;
    const fm = frontmatter({
      linear_type: 'issue', linear_id: issue.uuid || issue.id, identifier: issue.id, title: q(issue.title),
      state: issue.status || null, priority: (issue.priority && issue.priority.value) ?? 0, assignee: assignee || 'null',
      team: String(issue.id).split('-')[0], project: issue.project || 'null', url: issue.url,
      created_at: issue.createdAt, updated_at: issue.updatedAt, tags: ['linear', 'issue'],
    });
    files.set(`linear/issues/${issue.id}.md`, `${fm}\n\n# ${issue.id} — ${issue.title}\n\n${String(issue.description || '').trim()}\n${renderComments(comments, issue.url)}\n`);
  }

  for (const p of projects) {
    const full = (gp.results.get(gp.keyOf({ query: p.id })) || [])[0] || p;
    bump(p.updatedAt);
    const info = projectInfo.get(p.name);
    const fm = frontmatter({
      linear_type: 'project', linear_id: p.uuid || p.id, title: q(p.name), state: (p.status && p.status.name) || 'null',
      lead: (p.lead && p.lead.name) || 'null', team: (p.leadTeam && p.leadTeam.name) || 'null',
      initiatives: (p.initiatives || []).map((i) => q(i.name)), workstream: info && info.workstreams && info.workstreams.length ? q(info.workstreams.join(', ')) : 'null',
      url: q(p.url), created_at: p.createdAt, updated_at: p.updatedAt, completed_at: p.completedAt || 'None', canceled_at: p.canceledAt || 'None',
      tags: ['linear', 'project'],
    });
    files.set(`linear/projects/${p.uuid || p.id}.md`, `${fm}\n\n# ${p.name}\n\n${String(full.description || p.description || '').trim()}\n`);
  }

  for (const d of docs) {
    bump(d.updatedAt);
    const fm = frontmatter({
      linear_type: 'document', linear_id: d.id, title: q(d.title),
      creator: (d.creator && d.creator.name) || 'null', updated_by: (d.updatedBy && d.updatedBy.name) || 'null',
      project: d.project ? q(d.project.name) : 'null', initiative: d.initiative ? q(d.initiative.name) : 'null',
      team: d.team ? q(d.team.name || d.team.key) : 'null', issue: d.issue ? (d.issue.identifier || d.issue.id || 'null') : 'null',
      url: d.url, created_at: d.createdAt, updated_at: d.updatedAt, archived_at: d.archivedAt || 'null', tags: ['linear', 'document'],
    });
    files.set(`linear/docs/${d.id}.md`, `${fm}\n\n# ${d.title}\n\n${String(d.content || '').trim()}\n`);
  }

  const parentOf = new Map(scope.initiatives.map((i) => [i.id, i.parent_id]));
  const nameOf = new Map(scope.initiatives.map((i) => [i.id, i.name]));
  for (const i of initiatives) {
    bump(i.updatedAt);
    const parent = parentOf.get(i.id);
    const fm = frontmatter({
      linear_type: 'initiative', linear_id: i.id, title: q(i.name), status: q(i.status && (i.status.name || i.status)),
      health: i.health ? q(i.health) : 'null', owner: q(i.owner && (i.owner.name || i.owner)), creator: q(i.creator && (i.creator.name || i.creator)),
      parent_initiative: parent ? q(nameOf.get(parent)) : 'null', url: i.url, target_date: i.targetDate || 'null',
      created_at: i.createdAt, updated_at: i.updatedAt, tags: ['linear', 'initiative'],
    });
    files.set(`linear/initiatives/${i.id}.md`, `${fm}\n\n# ${i.name}\n\n${String(i.description || i.content || '').trim()}\n`);
  }

  if (tiers.configured && !cat.unfinished.length) {
    const rows = [];
    for (const w of tiers.linkWorkstreams) {
      const ps = (cat.results.get(cat.keyOf({ initiative: w.id, includeArchived: true, limit: 50, fields: catFields })) || [])
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      rows.push('', `## ${w.name} (${ps.length})`, '', '| Project | Status | Lead | Target | Updated | Link |', '|---|---|---|---|---|---|');
      for (const p of ps) rows.push(`| ${String(p.name).replace(/\|/g, '/')} | ${(p.status && (typeof p.status === 'string' ? p.status : p.status.name)) || ''} | ${personName(p.lead)} | ${p.targetDate || ''} | ${String(p.updatedAt || '').slice(0, 10)} | [↗](${p.url}) |`);
    }
    const fm = frontmatter({ linear_type: 'catalog', tier: 'link-only', workstreams: tiers.linkWorkstreams.map((w) => q(w.name)), tags: ['linear', 'catalog'] });
    files.set('linear/catalog.md', `${fm}\n\n# Linear catalog: link-only projects\n${rows.join('\n')}\n`);
  }

  // Issues listed but not rendered (detail or comments failed) go to the
  // ledger; they don't hold the watermark.
  const missingIssues = issueIds.filter((id) => !files.has(`linear/issues/${id}.md`));
  log(`rendered ${files.size} file(s); ${unfinished.length} call(s) unfinished`);
  for (const u of unfinished.slice(0, 8)) log(`gap: ${u}`);

  const { problems, notes } = verify(vault, src, { emitted: [...files.keys()] }, files, { since, today: now }, { modelAuthored: false });
  for (const n of notes) log(`note: ${n}`);
  for (const p of problems) log(`GATE: ${p}`);
  if (problems.length) return finish(run, 'error', `gate failed (${problems.length}); nothing written`, { problems }, cost);

  const { written, skipped } = commit(vault, files);
  writePending(vault, 'linear', missingIssues);
  let moved = 'unchanged';
  if (listFailed.length) moved = `HELD (${listFailed.length} list/project call(s) unfinished)`;
  else if (maxUpdated && (!wm || maxUpdated > wm)) {
    fs.writeFileSync(path.join(vault, 'linear', '.last-sync'), `${iso(maxUpdated)}\n`);
    moved = `→ ${iso(maxUpdated).slice(0, 16)}Z`;
  }
  finish(run, listFailed.length || missingIssues.length ? 'warn' : 'ok',
    `${written} written, ${skipped} unchanged · ${issueIds.length} issues, ${projects.length} projects, ${docs.length} docs, ${initiatives.length} initiatives · watermark ${moved}${missingIssues.length ? ` · ${missingIssues.length} issue(s) pending for next run` : ''}`,
    { issues: issueIds.length, projects: projects.length, docs: docs.length, initiatives: initiatives.length, unfinished: unfinished.length, pending: missingIssues }, cost);
}

module.exports = { syncLinearMcp, renderComments };
