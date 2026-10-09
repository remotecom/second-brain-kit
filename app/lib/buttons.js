// The "model presses buttons" runner shared by the Slack, Linear and Notion
// sync bots. The model (haiku) gets ONLY the named connector tools: no Bash,
// Read or Write (--tools ToolSearch). It is told exactly which calls to make.
// The runner collects every (tool input, raw tool result) pair from the
// stream; plain code turns those into files. The model writes nothing, so it
// can't summarize, invent, or substitute content (2026-10-01).

const fs = require('fs');
const { claudeCall } = require('./claude-call');
const { serverName, connectorError, NAMES } = require('./connectors');

// 'mcp__claude_ai_Google_Calendar__list_events' -> 'gcal' (by the known names).
const sourceOf = (tool) => Object.keys(NAMES).find((k) => serverName(tool.split('__').slice(0, 2).join('__')) === `claude.ai ${NAMES[k]}`) || 'connector';

// Claude Code moves a tool result over ~50KB out of the conversation and hands
// the model a "<persisted-output> ... saved to: <path>" stub instead. The full
// result is in that file (a JSON array of content parts), so read it back.
// Without this, every big page/thread silently counted as "never returned"
// (measured 2026-10-01: 9 of 89 Notion pages, incl. a 4.2MB one).
function resolvePersisted(text) {
  // Two stub shapes: "<persisted-output> … saved to: X.json" (over ~50KB) and
  // "Error: result (N characters …) exceeds maximum allowed tokens. Output has
  // been saved to X.txt." (very large, e.g. a 300K-char Notion page).
  const m = /^<persisted-output>[\s\S]*?saved to: (\S+\.(?:json|txt))/.exec(text)
    || /^Error: result \([\d,]+ characters[^)]*\) exceeds maximum allowed tokens\. Output has been saved to (\S+?\.(?:json|txt))\.?\s/.exec(text);
  if (!m) return text;
  try {
    const raw = fs.readFileSync(m[1], 'utf8');
    try { const a = JSON.parse(raw); if (Array.isArray(a)) return a.map((c) => c.text || '').join(''); } catch {}
    return raw;
  } catch { return text; }
}


// Runs the model with ONLY the Slack tools and returns every
// (tool input, tool result text) pair seen in the stream.
// Whether a connector is really there, decided by code from the stream, not
// by the model (a model asked "is it connected?" says yes, measured
// 2026-10-09). Two signals:
//   init:       the server's status. needs-auth / failed = not connected.
//               pending = still connecting, no verdict yet.
//   ToolSearch: "No matching deferred tools found" while the server is NOT in
//               the "still connecting" list = it connected and has no such
//               tool (a logged-out connector exposes only `authenticate`).
function connectorVerdict(servers, searches, tools) {
  const names = [...new Set(tools.map((t) => serverName(t.split('__').slice(0, 2).join('__'))).filter(Boolean))];
  for (const n of names) {
    const s = servers.find((x) => x.name === n);
    if (s && (s.status === 'needs-auth' || s.status === 'failed')) return { problem: s.status, server: n };
  }
  for (const text of searches) {
    if (!/No matching deferred tools found/.test(text)) continue;
    // Server names contain dots ("claude.ai Slack"), so the list ends at ". Their".
    const connecting = (/still connecting: (.*?)\.(?: Their|\s*$)/.exec(text) || [])[1] || '';
    const n = names.find((x) => !connecting.split(/,\s*/).includes(x));
    if (n) return { problem: 'no-tools', server: n };
  }
  return null;
}

async function pressButtons(ctx, run, instructions, budget, tools) {
  const calls = new Map(); // tool_use_id -> { name, input, text }
  const searchIds = new Set(), searches = [];
  let servers = [];
  const r = await claudeCall(ctx, {
    prompt: instructions, model: 'haiku',
    tools: 'ToolSearch',                             // no Bash/Read/Write at all
    allowed: ['ToolSearch', ...tools],
    mcp: true,                                       // the connector's buttons
    budget, timeoutMs: 30 * 60000,
    onEvent: (ev) => {
      if (ev.type === 'system' && ev.subtype === 'init') servers = ev.mcp_servers || [];
      const parts = (ev.message && ev.message.content) || [];
      if (ev.type === 'assistant') {
        for (const p of parts) {
          if (p.type === 'tool_use' && tools.includes(p.name)) calls.set(p.id, { name: p.name, input: p.input });
          if (p.type === 'tool_use' && p.name === 'ToolSearch') searchIds.add(p.id);
        }
      } else if (ev.type === 'user') {
        for (const p of parts) {
          if (p.type !== 'tool_result') continue;
          const text = Array.isArray(p.content) ? p.content.map((c) => c.text || '').join('') : String(p.content || '');
          if (searchIds.has(p.tool_use_id)) searches.push(text);
          if (calls.has(p.tool_use_id)) calls.get(p.tool_use_id).text = resolvePersisted(text);
        }
      }
    },
  });
  const cost = (r.result && r.result.total_cost_usd) || 0;
  ctx.logLine(run, `  run: ${calls.size} tool call(s), $${cost.toFixed(3)}${r.result && r.result.subtype === 'error_max_budget_usd' ? ' (hit budget)' : ''}`);
  const got = [...calls.values()].filter((c) => c.text !== undefined);
  return { calls: got, cost, connector: got.length ? null : connectorVerdict(servers, searches, tools), servers, searches };
}


// Stable identity for a call: its arguments minus the page cursor (Linear and
// Notion call it cursor, Google calls it pageToken).
const keyOf = (tool, args) => {
  const a = { ...(args || {}) }; delete a.cursor; delete a.pageToken;
  return `${tool} ${JSON.stringify(Object.keys(a).sort().reduce((o, k) => ((o[k] = a[k]), o), {}))}`;
};

// Run a list of exact calls to ONE tool, to exhaustion. Each job is
// { args }. `pageOf(json)` turns a parsed result into { items, next } where
// next is the cursor for the following page (or null). The model is told the
// exact calls; the runner matches results back to jobs by their arguments,
// follows cursors itself in the next round if the model stopped early, and
// retries jobs that never came back. Returns { results: Map(jobKey -> items[]),
// unfinished: [jobKey], cost }.
async function collect(ctx, run, tool, jobs, { pageOf, batch = 25, budget = 2, maxRounds = 4, label = tool.split('__').pop(), cursorKey = 'cursor', followPages = true }) {
  const results = new Map();
  let pending = jobs.map((j) => ({ args: j.args, cursor: null, key: keyOf(tool, j.args) }));
  let cost = 0;
  for (let round = 1; pending.length && round <= maxRounds; round++) {
    const still = [];
    for (let i = 0; i < pending.length; i += batch) {
      const chunk = pending.slice(i, i + batch);
      const instr = [
        `Call the tool ${tool} once for EACH argument object below, exactly as given (load it with ToolSearch "select:${tool}" first):`,
        ...chunk.map((p) => `  ${JSON.stringify({ ...p.args, ...(p.cursor ? { [cursorKey]: p.cursor } : {}) })}`),
        followPages
          ? 'If a result says there is a next page (hasNextPage true, a cursor, or similar), call again with the SAME arguments plus that cursor, until there is no next page. Run independent calls in parallel, many per message.'
          // The runner decides when to stop (e.g. a list with no time filter): one page per call.
          : 'Call each exactly once; do NOT follow next-page cursors yourself. Run independent calls in parallel, many per message.',
        'Do not read, summarize or judge the results. When all calls are done, reply with the single word DONE.',
      ].join('\n');
      const r = await pressButtons(ctx, run, instr, budget, [tool]);
      cost += r.cost;
      // Not connected: stop now with a fix, instead of 4 rounds that end in
      // "never finished" (an unauthorized connector used to look like that).
      if (r.connector && !results.size) throw Object.assign(connectorError(ctx.source || sourceOf(tool), `${r.connector.server}: ${r.connector.problem}`), { cost });
      const byKey = new Map();
      for (const c of r.calls) {
        const k = keyOf(tool, c.input);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(c);
      }
      for (const p of chunk) {
        const calls = byKey.get(p.key) || [];
        let next = null, got = false;
        for (const c of calls) {
          let j; try { j = JSON.parse(c.text); } catch { continue; }
          const pg = pageOf(j);
          if (!pg) continue;
          got = true;
          if (!results.has(p.key)) results.set(p.key, []);
          results.get(p.key).push(...pg.items);
          next = pg.next; // calls arrive in order, so the last one decides
        }
        if (!got) still.push(p);
        else if (next) still.push({ ...p, cursor: next });
      }
    }
    ctx.logLine(run, `${label} round ${round}: ${jobs.length - still.length}/${jobs.length} done`);
    pending = still;
  }
  return { results, unfinished: pending.map((p) => p.key), cost, keyOf: (args) => keyOf(tool, args) };
}

module.exports = { pressButtons, collect, keyOf, resolvePersisted, connectorVerdict };
