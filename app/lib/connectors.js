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

module.exports = { tool, prefix, serverName, connectorError, NAMES, SETTINGS_URL };
