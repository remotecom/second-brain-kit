// Every unattended `claude -p` call the app makes is built here, so all bots
// share one set of safety flags instead of seven copy-pasted lists.
//
// What every bot call gets:
//   --setting-sources ""      none of the owner's settings, permission rules or
//                             CLAUDE.md files apply inside a bot. Login still
//                             works. EXCEPT a call that needs the claude.ai
//                             connectors (mcp: true): they load only with the
//                             user source (measured 2026-10-09: 50 connector
//                             servers with `user`, 0 with "", 3 runs each), so
//                             those calls load `user` and nothing else.
//   --settings bot-settings   the kit's floor, above user settings: ALL hooks
//                             off (a user or project hook stays silent, tested),
//                             Bash/Write/Edit/Web/Agent denied (deny beats any
//                             allow, including one from user settings)
//   --permission-prompts none anything not allowed is denied, never asked
//   --disallowedTools ...     belt and braces with the deny list
//   no MCP servers            unless the call needs connectors (mcp: true);
//                             connector tool definitions are ~600k tokens
//   ANTHROPIC_API_KEY unset   a stale key beats the claude.ai login and 401s
//
// Interactive sessions (Repair, vault chat) do NOT come through here: a human
// is watching them, so they run with the person's own settings.

const path = require('path');
const { spawn } = require('child_process');

const BOT_SETTINGS = path.resolve(__dirname, '..', 'bot-settings.json');
const NO_MCP = '{"mcpServers":{}}';
const DENY = 'Agent,Task,Write,Edit,NotebookEdit,Bash,WebFetch,WebSearch';

// The environment for a claude child: no API key (it beats the claude.ai
// login), and none of the markers a parent Claude Code session sets. Started
// from a Claude terminal, the app inherits CLAUDECODE / CLAUDE_CODE_* and its
// children then run as "child sessions" with transcript saving off (measured
// 2026-10-09), which breaks --resume.
function botEnv(base = process.env) {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  return env;
}

// o: { prompt, model, tools, allowed, mcp, budget, resume, persist, format, extra }
//   tools    built-in tools that exist at all ("" = none). Default Read,Glob,Grep.
//   allowed  tools that run without a prompt (array or comma string).
//   mcp      true = keep the account's claude.ai connectors.
//   persist  true = keep the session on disk (needed for a later --resume).
function botArgs(o) {
  const list = (x) => (Array.isArray(x) ? x.join(',') : String(x == null ? '' : x));
  const tools = o.tools === undefined ? 'Read,Glob,Grep' : list(o.tools);
  const args = [
    '-p', String(o.prompt),
    '--model', o.model || 'sonnet',
    ...(o.resume ? ['--resume', o.resume] : []),
    '--output-format', o.format || 'stream-json',
    ...((o.format || 'stream-json') === 'stream-json' ? ['--verbose'] : []),
    '--tools', tools,
    '--allowedTools', list(o.allowed !== undefined ? o.allowed : tools),
    '--disallowedTools', DENY,
    '--permission-prompts', 'none',
    '--setting-sources', o.mcp ? 'user' : '',
    '--settings', BOT_SETTINGS,
    ...(o.mcp ? [] : ['--strict-mcp-config', '--mcp-config', NO_MCP]),
    ...(o.budget ? ['--max-budget-usd', String(o.budget)] : []),
    ...(o.persist ? [] : ['--no-session-persistence']),
    ...(o.extra || []),
  ];
  return args;
}

// Run claude with stream-json so each tool call shows up in the board's log
// as it happens. Resolves with the final result event.
function claudeStream(claudeBin, args, { cwd, env, timeoutMs, onEvent = () => {} }) {
  return new Promise((resolve) => {
    const child = spawn(claudeBin, args, { cwd, env: env || botEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', result = null, err = '', rateFirst = null, rateLast = null;
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'rate_limit_event') { rateLast = ev.rate_limit_info; if (!rateFirst) rateFirst = rateLast; }
        if (ev.type === 'result') result = ev; else onEvent(ev);
      }
    });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs || 30 * 60000);
    child.on('error', (e) => { err += String(e.message); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, result, stderr: err.slice(-2000), rateFirst, rateLast }); });
  });
}

// One bot call. ctx = { claudeBin, vault, env }; o as botArgs, plus timeoutMs
// and onEvent.
// Every call's plan usage is recorded (lib/usage.js) for the daily cap.
async function claudeCall(ctx, o) {
  const r = await claudeStream(ctx.claudeBin, botArgs(o), { cwd: o.cwd || ctx.vault, env: ctx.env || botEnv(), timeoutMs: o.timeoutMs, onEvent: o.onEvent });
  try { require('./usage').record(ctx.usageVault || ctx.vault, r); } catch {}
  return r;
}

module.exports = { claudeCall, claudeStream, botArgs, botEnv, BOT_SETTINGS, DENY };
