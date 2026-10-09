// node --test: a logged-out connector fails fast with a fix, decided by code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collect, connectorVerdict } = require('../lib/buttons');
const C = require('../lib/connectors');

const FAKE = path.join(__dirname, 'fake', 'claude-noauth.js');
const T = ['mcp__claude_ai_Slack__slack_read_thread'];
const P = [{ name: 'claude.ai Slack', status: 'pending' }];

test('verdict: needs-auth / failed at init', () => {
  assert.deepEqual(connectorVerdict([{ name: 'claude.ai Slack', status: 'needs-auth' }], [], T), { problem: 'needs-auth', server: 'claude.ai Slack' });
  assert.equal(connectorVerdict([{ name: 'claude.ai Slack', status: 'failed' }], [], T).problem, 'failed');
});

test('verdict: no such tool once the server is done connecting', () => {
  assert.equal(connectorVerdict(P, ['No matching deferred tools found. Some MCP servers are still connecting: claude.ai Notion, claude.ai Gmail. Their tools will'], T).problem, 'no-tools');
  assert.equal(connectorVerdict(P, ['No matching deferred tools found.'], T).problem, 'no-tools');
});

test('verdict: no verdict while the server is still connecting, or when ToolSearch found it', () => {
  assert.equal(connectorVerdict(P, ['No matching deferred tools found. Some MCP servers are still connecting: claude.ai Notion, claude.ai Slack. Their tools'], T), null);
  assert.equal(connectorVerdict(P, ['<functions>…</functions>'], T), null);
});

test('serverName and tool names follow config.yaml connectors', () => {
  assert.equal(C.serverName('mcp__claude_ai_Google_Calendar'), 'claude.ai Google Calendar');
  assert.equal(C.serverName('mcp__plugin_linear_linear'), null);
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-conn-'));
  fs.writeFileSync(path.join(v, 'config.yaml'), 'connectors:\n  linear: "mcp__claude_ai_Linear_Gateway"\n');
  assert.equal(C.tool(v, 'linear', 'list_issues'), 'mcp__claude_ai_Linear_Gateway__list_issues');
  assert.equal(C.tool(v, 'slack', 'slack_read_thread'), 'mcp__claude_ai_Slack__slack_read_thread');
});

for (const mode of ['needs-auth', 'no-tools']) {
  test(`collect() stops in under 10 s with kind auth and the fix link (${mode})`, async () => {
    const lines = [];
    const ctx = { claudeBin: FAKE, vault: os.tmpdir(), env: { ...process.env, FAKE_MODE: mode, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, logLine: (_, s) => lines.push(s) };
    const t0 = Date.now();
    await assert.rejects(
      collect(ctx, {}, 'mcp__claude_ai_Google_Calendar__list_events', [{ args: { calendarId: 'me' } }], { pageOf: () => null }),
      (e) => e.kind === 'auth' && e.source === 'gcal' && e.fix === C.SETTINGS_URL && /Google Calendar is not connected/.test(e.message),
    );
    assert.ok(Date.now() - t0 < 10000);
    assert.ok(!lines.some((l) => /round 2/.test(l)), 'no retry rounds');
  });
}
