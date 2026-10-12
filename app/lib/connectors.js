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

// Connector tools that WRITE (send, save, share, delete...). Unattended bots
// load the owner's user settings (connectors need it), and a user allow rule
// such as "mcp__claude_ai_Slack" would let a bot call any of these with no
// prompt; synced text could ask it to. So every bot call disallows them by
// name for each configured prefix (taken from the connectors' real tool lists).
const WRITE_TOOLS = {
  slack: ['slack_send_message', 'slack_send_message_draft', 'slack_schedule_message', 'slack_create_canvas', 'slack_update_canvas', 'slack_add_reaction', 'slack_create_conversation'],
  linear: ['save_issue', 'save_comment', 'save_project', 'save_document', 'save_initiative', 'save_milestone', 'save_status_update', 'save_customer', 'save_customer_need', 'save_release', 'save_release_note', 'save_issue_label', 'save_project_label', 'save_initiative_label', 'save_diff_comment', 'create_attachment', 'create_attachment_from_upload', 'create_issue_label', 'create_initiative_label', 'prepare_attachment_upload', 'delete_comment', 'delete_attachment', 'delete_customer', 'delete_customer_need', 'delete_status_update', 'delete_diff_comment', 'share_issue', 'unshare_issue', 'mark_notification', 'merge_diff', 'update_diff', 'submit_diff_review', 'resolve_diff_thread', 'retire_issue_label', 'retire_project_label', 'retire_initiative_label', 'restore_issue_label', 'restore_project_label', 'restore_initiative_label'],
  notion: ['notion-create-pages', 'notion-update-page', 'notion-create-database', 'notion-update-data-source', 'notion-create-view', 'notion-update-view', 'notion-create-comment', 'notion-move-pages', 'notion-duplicate-page', 'notion-restore-pages', 'notion-create-folder', 'notion-update-folder', 'notion-create-file-upload', 'notion-create-attachment', 'notion-upload-skill', 'notion-convert-page-to-skill', 'notion-spawn-session', 'notion-send-message-to-session', 'notion-stop-session'],
  gcal: ['create_event', 'update_event', 'delete_event', 'respond_to_event'],
  gdrive: ['create_file', 'update_file', 'copy_file', 'share_file', 'trash_file'],
};
function writeToolDeny(vault) {
  let c = {}; try { c = getConfig(vault).connectors || {}; } catch {}
  const out = [];
  for (const [k, names] of Object.entries(WRITE_TOOLS)) {
    const prefixes = new Set([c[k], `mcp__claude_ai_${NAMES[k].replace(/ /g, '_')}`].filter(Boolean));
    for (const p of prefixes) for (const n of names) out.push(`${p}__${n}`);
  }
  return out;
}

module.exports = { WRITE_TOOLS, writeToolDeny, tool, prefix, serverName, connectorError, NAMES, SETTINGS_URL, HEALTH_CALLS, REQUIRED, judgeResult };
