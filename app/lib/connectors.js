// claude.ai connector tool names. They differ per account (the same Linear
// connector can be mcp__claude_ai_Linear or mcp__claude_ai_Linear_Gateway), so
// the prefix comes from config.yaml connectors.<source>, which Setup probes.
//
//   tool(vault, 'gcal', 'list_events') -> mcp__claude_ai_Google_Calendar__list_events
//   serverName(prefix)                 -> "claude.ai Google Calendar" (as init reports it)
//   connectorError(source, why)        -> an Error with kind 'auth' and the fix

const { getConfig } = require('./config');

const NAMES = { slack: 'Slack', linear: 'Linear', notion: 'Notion', gcal: 'Google Calendar', gdrive: 'Google Drive' };
const SETTINGS_URL = 'https://claude.ai/settings/connectors';

const prefix = (vault, source) => String(getConfig(vault).connectors[source] || '');
const tool = (vault, source, name) => `${prefix(vault, source)}__${name}`;

// The MCP server name the stream's init event uses for a tool prefix.
function serverName(p) {
  const m = /^mcp__claude_ai_(.+)$/.exec(p);
  return m ? `claude.ai ${m[1].replace(/_/g, ' ')}` : null;
}

function connectorError(source, why) {
  const name = NAMES[source] || source;
  return Object.assign(new Error(`${name} is not connected (${why}). Open claude.ai → Settings → Connectors and connect ${name}, then run this again.`), {
    kind: 'auth', source, fix: SETTINGS_URL,
  });
}

// One cheap read per source (health probe, Setup's connector probe).
// slack_read_user_profile with no user_id reads the caller's own profile.
const HEALTH_CALLS = {
  slack: ['slack_read_user_profile', (o) => (o.slack_user_id && !/X{4,}/.test(o.slack_user_id) ? { user_id: o.slack_user_id, response_format: 'concise' } : { response_format: 'concise' })],
  linear: ['list_teams', () => ({ limit: 1 })],
  notion: ['notion-get-users', () => ({ page_size: 1 })],
  gcal: ['list_calendars', () => ({})],
  gdrive: ['list_recent_files', () => ({ pageSize: 1 })],
};
// The tool each source's sync cannot do without; Setup finds prefixes by it.
const REQUIRED = { slack: 'slack_search_public_and_private', linear: 'list_issues', notion: 'notion-search', gcal: 'list_events', gdrive: 'search_files' };

// A tool call's result as a status: ok | auth | error | none (no call came back).
function judgeResult(c) {
  if (!c) return { status: 'none' };
  const text = String(c.text || '');
  if (/insufficient scope|not authenticated|unauthori[sz]ed|authenticate first|invalid[_ ]token/i.test(text)) return { status: 'auth', why: text.slice(0, 120) };
  if (/^Error/i.test(text)) return { status: 'error', why: text.slice(0, 120) };
  return { status: 'ok' };
}

module.exports = { tool, prefix, serverName, connectorError, NAMES, SETTINGS_URL, HEALTH_CALLS, REQUIRED, judgeResult };
