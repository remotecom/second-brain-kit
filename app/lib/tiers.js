// Linear depth tiers, shared by the Linear sync and the ingest bot so they can
// never disagree. config.yaml names the initiatives that get DEEP treatment
// (every issue, comment and document, synced and ingested). The rest of the
// scope tree is LINK-ONLY: one catalog row per project with its Linear URL,
// never fetched in detail and never ingested. Issues assigned to the owner or
// mentioning them stay deep wherever they live.
//
//   linear:
//     deep_initiatives:
//       - 00000000-0000-0000-0000-000000000000   # your initiative's Linear ID
//
// No deep_initiatives configured = everything is deep (the old behaviour).

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');

const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function linearTiers(vault, scope) {
  if (!scope) { try { scope = JSON.parse(fs.readFileSync(path.join(vault, 'linear', '.initiative-scope.json'), 'utf8')); } catch { scope = { initiatives: [], projects: [] }; } }
  // A team scope has no initiative tree: everything in it is deep.
  const roots = scope.team ? [] : getConfig(vault).linear.deep_initiatives.map(String);
  if (!roots.length) return { configured: false, isDeepProject: () => true, isDeepInitiative: () => true, deepProjects: scope.projects, linkProjects: [], linkWorkstreams: [], roots };
  // The subtree under each deep root.
  const kids = new Map();
  for (const i of scope.initiatives) { if (!kids.has(i.parent_id)) kids.set(i.parent_id, []); kids.get(i.parent_id).push(i); }
  const deepInits = new Set();
  const visit = (id) => { if (deepInits.has(id)) return; deepInits.add(id); for (const k of kids.get(id) || []) visit(k.id); };
  roots.forEach(visit);
  // Projects carry only their top-level workstream labels, so a deep root
  // must be a top-level workstream until the scope cache records per-project
  // initiatives. Say so loudly rather than silently mis-tiering.
  const top = scope.initiatives.filter((i) => i.parent_id === scope.root_id);
  const deepWs = new Set(top.filter((i) => deepInits.has(i.id)).map((i) => i.name));
  const unsupported = roots.filter((r) => !top.some((t) => t.id === r));
  if (unsupported.length) throw new Error(`linear.deep_initiatives must be top-level workstreams of the scope root for now: ${unsupported.join(', ')}`);
  const isDeepWs = (p) => (p.workstreams || []).some((w) => deepWs.has(w));
  const deepProjects = scope.projects.filter(isDeepWs);
  const linkProjects = scope.projects.filter((p) => !isDeepWs(p));
  const deepNames = new Set(deepProjects.map((p) => norm(p.name)));
  const deepIds = new Set(deepProjects.map((p) => p.id));
  return {
    configured: true, roots, deepProjects, linkProjects,
    linkWorkstreams: top.filter((i) => !deepInits.has(i.id)),
    isDeepProject: (idOrName) => deepIds.has(idOrName) || deepNames.has(norm(idOrName)),
    isDeepInitiative: (id) => deepInits.has(id),
  };
}

module.exports = { linearTiers, norm };
