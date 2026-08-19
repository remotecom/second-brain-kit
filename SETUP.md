# Setup — from clone to first answer in ~30 minutes

## 0. Prerequisites

- [Claude Code](https://claude.com/claude-code) installed and working.
- A terminal with `bash`, `git`, and `date` (macOS or Linux).
- Access to the sources you want: Slack, Linear, and/or Notion.
- (Optional) [Obsidian](https://obsidian.md) to open the folder as a vault and
  get the graph view. Everything works without it — it's just markdown.

## 1. Clone and name your vault

```bash
git clone <this-repo> my-vault
cd my-vault
```

You can call the folder anything. This is now *your* vault.

> **Launch Claude Code from inside the vault** (`cd my-vault && claude`). The ops
> write fetched Slack/Linear/Notion content to disk here; Claude Code's safety
> classifier can block writes to folders *outside* the session's working
> directory, so keep the vault as the working dir (or an explicitly allowed
> path). If a daily-file write ever gets blocked, this is almost always why.

## 2. Stop Claude Code from deleting your memories (do this first)

Claude Code defaults to a **30-day transcript retention**, and your project
memories live inside the transcript dir — so untouched projects get their
memory swept. Set retention to effectively-never by merging
`settings.example.json` into `~/.claude/settings.json`:

```jsonc
{
  "cleanupPeriodDays": 36500
}
```

Merge the key — don't overwrite your existing settings. This is the single most
important step; skipping it silently loses your raw memory layer.

## 3. Connect your MCP sources

In Claude Code, run `/mcp` and connect the connectors for the sources you
enabled. The ops call these tool families:

| Source | What you need | Default |
|---|---|---|
| Slack  | a Slack MCP with search + thread-read + send-message | `enabled: true` |
| Linear | a Linear MCP with list/get issues, projects, initiatives, docs, comments | `enabled: true` |
| Notion | a Notion MCP with search, fetch, comments, data-source query | `enabled: true` |
| Google Drive | Drive MCP with `search_files`, `list_recent_files`, `read_file_content` | `enabled: false` |
| Gmail | Gmail MCP with `search_threads`, `get_thread` | `enabled: false` |
| Google Calendar | Calendar MCP with `list_calendars`, `list_events`, `get_event` | `enabled: false` |

If a connector isn't available for a source, set `enabled: false` for it in
`config.yaml` and the ops will skip it.

**The Google sources ship disabled on purpose.** Gmail and Calendar expose only
`authenticate` / `complete_authentication` until you connect them in `/mcp` —
the real tools do not exist before that. And plenty of Workspace tenants block
third-party Drive/Gmail OAuth scopes at the admin level, so you may not be able
to enable them at all. Flip `enabled: true` only once `/mcp` shows the connector
working.

**First run of a Google source is slow.** With no `.last-sync` yet, the source
back-fills `bootstrap_horizon_days` of history once (default 365) before
settling into the rolling window. That is expected, not a hang.

**Read the sensitivity denylist before enabling Gmail.** These are personal
accounts. `config.yaml`'s `exclude_labels` / `exclude_categories` /
`exclude_folders` / `include_private` are applied at fetch time so excluded
content never lands on disk. `.gitignore` only keeps things out of git — it does
not keep them out of the plaintext files every vault session reads, or out of
synthesized wiki pages.

## 4. Fill in your config

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml`:

- `owner.slack_user_id` — your Slack member ID (Slack → your profile → *More* →
  *Copy member ID*).
- `sources.linear.team_key` — the Linear team you want synthesized.
- `sources.notion.watched_databases` — leave empty to start; add databases you
  live in (meeting notes, OKRs, trackers). First `sync notion` bootstraps the
  allowlist by name and asks you to confirm.
- Leave `owner.notion_user_id` blank; it's resolved and cached on first run.

## 5. Seed the wiki scaffolding

```bash
cp templates/index.template.md wiki/index.md
cp templates/log.template.md   wiki/log.md
cp templates/principles/outbound-voice.example.md wiki/principles/outbound-voice.md
```

Then open `wiki/principles/outbound-voice.md` and rewrite it in your own voice
(or delete it if you don't want an outbound gate).

Optionally paste `templates/global-claude-md.template.md` into your
`~/.claude/CLAUDE.md` so auto-memory writes memories the vault can ingest.

## 6. Make the taxonomy yours (optional but recommended)

The default `wiki/` sections suit a partnerships / solutions-architecture
function. If yours is different, edit `wiki.sections` in `config.yaml` and
rename the folders under `wiki/` to match. Examples:

| Function | Sections that tend to matter |
|---|---|
| Engineering | services · runbooks · postmortems · rfcs · dependencies · people |
| BizOps | accounts · processes · metrics · vendors · decisions · people |
| Product | features · personas · competitors · experiments · decisions · people |

Keep `principles/`, `people/`, `initiatives/`, `concepts/`, `workflows/` — they
are useful in almost every function.

## 7. First run

In Claude Code, from the vault directory:

```
sync            # pulls the last 4 days from each enabled source
ingest          # folds the new raw files into the wiki
```

Then ask it something:

```
what do we know about <a project / person / topic you touched this week>?
```

Day one it will be thin — that's expected. Run `sync` + `ingest` on your normal
cadence (daily or a few times a week). Within a couple of weeks it starts
answering things faster than you could find them.

## 8. Keep it healthy

- `sync` before `ingest`, always.
- Run `bash scripts/refresh-project-symlinks.sh` before `ingest` if you work
  across multiple Claude Code projects (it re-links memory dirs; a dangling
  symlink is skipped silently).
- `lint` occasionally to catch orphans, stale pages, dead links, and taxonomy
  drift. `bash scripts/linkrot-lint.sh` is the mechanical half — it should exit
  `0` and print **six** sections. Anything less means it aborted early.
- `bash tests/run.sh` after changing anything in `scripts/` or `.gitignore`.
  It pins the watermark-cutoff behaviour and the both-directions leak test.

## Troubleshooting

- **`sync` finds nothing** — check the MCP is connected (`/mcp`), that the
  source is `enabled: true`, and that your `config.yaml` IDs/team are right.
- **`lint` prints a short, clean-looking report** — count the sections. A report
  that stops before `## 2.` has aborted, not passed. `bash tests/run.sh` checks
  this specifically.
- **`ingest` walks 0 files** — the watermark (`wiki/.last-ingest`) may be ahead
  of your raw file dates, or a project symlink is dangling. See the ingest op in
  `CLAUDE.md`.
- **A daily-file write got blocked** — you're likely running Claude Code from
  outside the vault. `cd` into the vault and launch `claude` from there (see
  step 1), or add the vault path to your allowed dirs.
- **Memories vanished** — you skipped step 2. Set `cleanupPeriodDays`.
- **Want to version your vault** — do it in a *separate private repo*. Don't
  push your data back to this template; that's what `.gitignore` protects.
