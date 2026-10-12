#!/usr/bin/env node
// A fake `claude -p` for tests: the connector the call needs is logged out.
// FAKE_MODE=needs-auth: init reports the server as needs-auth.
// FAKE_MODE=no-tools:   init says pending; ToolSearch finds no such tool.
const mode = process.env.FAKE_MODE || 'needs-auth';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', tools: ['ToolSearch'], mcp_servers: [
  { name: 'claude.ai Google Calendar', status: mode === 'needs-auth' ? 'needs-auth' : 'pending' },
  { name: 'claude.ai Notion', status: 'pending' },
] });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'select:x' } }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'No matching deferred tools found. Some MCP servers are still connecting: claude.ai Notion. Their tools will become available shortly.' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', total_cost_usd: 0.001 });
