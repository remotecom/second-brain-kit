#!/usr/bin/env node
// A fake `claude -p` for tests: the model calls the tool with an argument it
// was not told to add (asked for {}, sends {pageSize: 100}).
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const tool = 'mcp__claude_ai_Google_Calendar__list_calendars';
out({ type: 'system', subtype: 'init', tools: ['ToolSearch', tool], mcp_servers: [{ name: 'claude.ai Google Calendar', status: 'connected' }] });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: tool, input: { pageSize: 100 } }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ calendars: [{ id: 'me@example.com', summary: 'me@example.com' }] }) }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', total_cost_usd: 0.001 });
