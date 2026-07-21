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

| Source | What you need |
|---|---|
| Slack  | a Slack MCP with search + thread-read + send-message |
| Linear | a Linear MCP with list/get issues, projects, initiatives, docs, comments |
| Notion | a Notion MCP with search, fetch, comments, data-source query |

If a connector isn't available for a source, set `enabled: false` for it in
`config.yaml` and the ops will skip it.

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
  drift. `bash scripts/linkrot-lint.sh` is the mechanical half.

## Troubleshooting

- **`sync` finds nothing** — check the MCP is connected (`/mcp`) and your
  `config.yaml` IDs/team are right.
- **`ingest` walks 0 files** — the watermark (`wiki/.last-ingest`) may be ahead
  of your raw file dates, or a project symlink is dangling. See the ingest op in
  `CLAUDE.md`.
- **Memories vanished** — you skipped step 2. Set `cleanupPeriodDays`.
- **Want to version your vault** — do it in a *separate private repo*. Don't
  push your data back to this template; that's what `.gitignore` protects.
