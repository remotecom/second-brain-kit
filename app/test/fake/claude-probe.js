#!/usr/bin/env node
// A fake `claude -p` for the Setup connector probe. FAKE_TOOLS lists the tool
// names ToolSearch "finds"; FAKE_BAD lists prefixes whose calls fail auth.
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const tools = (process.env.FAKE_TOOLS || '').split(',').filter(Boolean);
const bad = (process.env.FAKE_BAD || '').split(',').filter(Boolean);
out({ type: 'system', subtype: 'init', tools: ['ToolSearch'], mcp_servers: [] });
let n = 0;
if (/Use ToolSearch/.test(prompt)) {
  for (const q of prompt.split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !/^Use/.test(l))) {
    const id = `s${n++}`;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'ToolSearch', input: { query: q } }] } });
    const hits = tools.filter((t) => t.endsWith(`__${q}`)).map((t) => ({ type: 'tool_reference', tool_name: t }));
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: hits.length ? hits : [{ type: 'text', text: 'No matching deferred tools found.' }] }] } });
  }
} else {
  for (const m of prompt.matchAll(/^\s+(mcp__\S+) (\{.*\})$/gm)) {
    const id = `c${n++}`;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: m[1], input: JSON.parse(m[2]) }] } });
    const isBad = bad.some((p) => m[1].startsWith(`${p}__`));
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: isBad ? 'Error: not authenticated' : '{"ok":true}' }] } });
  }
}
out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', total_cost_usd: 0.001 });
