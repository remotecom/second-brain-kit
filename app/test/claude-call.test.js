// node --test: every unattended bot call carries the kit's safety flags.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { botArgs, botEnv, BOT_SETTINGS } = require('../lib/claude-call');

const flag = (args, f) => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; };

test('calls load no setting sources, connector calls only `user`, all load the kit bot settings', () => {
  assert.equal(flag(botArgs({ prompt: 'x' }), '--setting-sources'), '');
  assert.equal(flag(botArgs({ prompt: 'x', mcp: true }), '--setting-sources'), 'user');
  for (const o of [{ prompt: 'x' }, { prompt: 'x', mcp: true, tools: 'ToolSearch' }, { prompt: 'x', persist: true, resume: 'abc' }]) {
    const a = botArgs(o);
    assert.ok(!/project|local/.test(flag(a, '--setting-sources')));
    assert.equal(flag(a, '--settings'), BOT_SETTINGS);
    assert.equal(flag(a, '--permission-prompts'), 'none');
    for (const t of ['Bash', 'Write', 'Edit', 'WebFetch', 'Agent']) assert.ok(flag(a, '--disallowedTools').split(',').includes(t), t);
  }
});

test('no MCP servers unless asked; connectors only with mcp: true', () => {
  assert.equal(flag(botArgs({ prompt: 'x' }), '--mcp-config'), '{"mcpServers":{}}');
  assert.ok(botArgs({ prompt: 'x' }).includes('--strict-mcp-config'));
  assert.ok(!botArgs({ prompt: 'x', mcp: true }).includes('--strict-mcp-config'));
});

test('sessions are not persisted unless a resume needs them', () => {
  assert.ok(botArgs({ prompt: 'x' }).includes('--no-session-persistence'));
  const a = botArgs({ prompt: 'x', persist: true, resume: 'r1' });
  assert.ok(!a.includes('--no-session-persistence'));
  assert.equal(flag(a, '--resume'), 'r1');
});

test('bot-settings.json turns hooks off and denies writes, shell and web', () => {
  const s = JSON.parse(fs.readFileSync(BOT_SETTINGS, 'utf8'));
  assert.equal(s.disableAllHooks, true);
  for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch']) assert.ok(s.permissions.deny.includes(t), t);
  assert.equal((s.permissions.allow || []).length, 0);
});

test('botEnv strips ANTHROPIC_API_KEY (it would beat the claude.ai login)', () => {
  const e = botEnv({ ANTHROPIC_API_KEY: 'sk-x', PATH: '/bin' });
  assert.equal(e.ANTHROPIC_API_KEY, undefined);
  assert.equal(e.PATH, '/bin');
});

test('no bot module builds its own claude flag list', () => {
  const dir = path.join(__dirname, '..', 'lib');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !['claude-call.js', 'doctor.js'].includes(n))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/'--setting-sources'/.test(src), `${f} passes --setting-sources itself`);
    assert.ok(!/'--permission-prompts'/.test(src), `${f} passes --permission-prompts itself`);
  }
});

test('botEnv strips the markers a parent Claude Code session sets', () => {
  const e = botEnv({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: '/x', HOME: '/h' });
  assert.equal(e.CLAUDECODE, undefined);
  assert.equal(e.CLAUDE_CODE_CHILD_SESSION, undefined);
  assert.equal(e.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(e.CLAUDE_CONFIG_DIR, '/x'); // other settings pass through
});
