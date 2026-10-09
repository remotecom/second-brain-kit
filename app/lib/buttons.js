// The "model presses buttons" runner shared by the Slack, Linear and Notion
// sync bots. The model (haiku) gets ONLY the named connector tools: no Bash,
// Read or Write (--tools ToolSearch). It is told exactly which calls to make.
// The runner collects every (tool input, raw tool result) pair from the
// stream; plain code turns those into files. The model writes nothing, so it
// can't summarize, invent, or substitute content (2026-10-01).

const fs = require('fs');
const { claudeStream } = require('./sync');

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
async function pressButtons(ctx, run, instructions, budget, tools) {
  const calls = new Map(); // tool_use_id -> { name, input, text }
  const r = await claudeStream(ctx.claudeBin, [
    '-p', instructions,
    '--model', 'haiku',
    '--output-format', 'stream-json', '--verbose',
    '--tools', 'ToolSearch',                         // no Bash/Read/Write at all
    '--allowedTools', ['ToolSearch', ...tools].join(','),
    '--permission-prompts', 'none',
    '--setting-sources', 'user',
    '--max-budget-usd', String(budget),
    '--no-session-persistence',
  ], {
    cwd: ctx.vault, env: ctx.env, timeoutMs: 30 * 60000,
    onEvent: (ev) => {
      const parts = (ev.message && ev.message.content) || [];
      if (ev.type === 'assistant') {
        for (const p of parts) if (p.type === 'tool_use' && tools.includes(p.name)) calls.set(p.id, { name: p.name, input: p.input });
      } else if (ev.type === 'user') {
        for (const p of parts) {
          if (p.type !== 'tool_result' || !calls.has(p.tool_use_id)) continue;
          const text = Array.isArray(p.content) ? p.content.map((c) => c.text || '').join('') : String(p.content || '');
          calls.get(p.tool_use_id).text = resolvePersisted(text);
        }
      }
    },
  });
  const cost = (r.result && r.result.total_cost_usd) || 0;
  ctx.logLine(run, `  run: ${calls.size} tool call(s), $${cost.toFixed(3)}${r.result && r.result.subtype === 'error_max_budget_usd' ? ' (hit budget)' : ''}`);
  return { calls: [...calls.values()].filter((c) => c.text !== undefined), cost };
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

module.exports = { pressButtons, collect, keyOf, resolvePersisted };
