# Second Brain Kit

A personal knowledge operating system you run locally with Claude Code. It pulls
your real work surfaces — Slack, Linear, Notion, Google Workspace (Drive, Gmail,
Calendar), and Claude's own project memories — into plain markdown, then synthesizes them into a wiki that
**writes and maintains itself**. Ask it a question, get one authoritative answer
instead of scrolling four tools.

Built for teams who keep re-deriving the same knowledge. Clone it, point it at
your sources, and it compounds from there.

## The three layers

1. **Raw sync (immutable).** `sync slack` / `sync linear` / `sync notion` /
   `sync gcal` / `sync gdrive` pull your activity into flat markdown, governed
   by watermarks, rolling re-fetch windows, content-hash idempotency, pre-fetch
   skip state, and verification gates. All five ship **disabled or enabled per
   source** in `config.yaml` — see SETUP.md.
   `sync gmail` is **specified but not implemented yet**; its class reports
   `SKIPPED-not-implemented` rather than a misleading `0`.
2. **LLM-maintained wiki.** `ingest` folds new raw deltas into synthesized,
   cross-linked pages (people, initiatives, concepts, workflows, and whatever
   entity types matter for your function) under explicit promotion thresholds.
3. **Query + memory.** Ask questions; it answers wiki-first and drills to raw
   only on gaps. Its auto-memory learns your preferences and voice over time.

Everything is markdown in a folder. Open it in [Obsidian](https://obsidian.md)
for the graph view, or just read the files.

## What you share vs. what stays yours

This repo is **machinery, not data**. It ships empty. Your synced content and
your synthesized wiki are `.gitignore`d by default so nothing proprietary ever
lands in a repo that started from this template. The transferable asset is the
method, encoded almost entirely in [`CLAUDE.md`](./CLAUDE.md).

## Quickstart

```bash
git clone <this-repo> my-vault && cd my-vault
cp config.example.yaml config.yaml         # fill in your team, IDs, sources
cp templates/index.template.md wiki/index.md
cp templates/log.template.md   wiki/log.md
# merge settings.example.json into ~/.claude/settings.json  (cleanupPeriodDays!)
claude                                       # open Claude Code in this dir
```

Then, in Claude Code:

```
sync            # pull the last few days from Slack + Linear + Notion
ingest          # fold the new raw into the wiki
what do we know about <topic>?     # query it
```

Full walkthrough: **[SETUP.md](./SETUP.md)**.

## Make it yours

The mechanics (sync/ingest/query/lint, the multi-agent orchestration) are the
same for everyone. Only two things are per-function, both in `config.yaml`:

- **Source scope** — your Linear team, Slack ID, watched Notion databases,
  watched Drive folders, and the sensitivity denylist for the Google sources.
- **Wiki taxonomy** — the entity types your synthesis organizes around. The
  defaults suit partnerships / solutions-architecture; swap them for eng
  (services / runbooks / postmortems), BizOps (accounts / processes / vendors),
  PM (features / personas / experiments), etc.

## The honest part

Day one, this is empty and unimpressive — you're just syncing. The value
**compounds**: a week in you're feeding it, a month in it answers things you'd
forgotten you knew. Give it a few weeks before you judge it.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- MCP connectors for the sources you enable: Slack, Linear, Notion, and
  optionally Google Calendar / Google Drive. (A Gmail connector isn't useful
  yet — the op isn't written.)
- `bash`, `git`, `date` (macOS/Linux). Optional: Obsidian for the visual layer.

## Contributing

`scripts/raw-classes.sh` is the single source of truth for what counts as a raw
layer; add a source there and nowhere else. Run `bash tests/run.sh` after
touching anything in `scripts/` or `.gitignore` — it pins the watermark-cutoff
behaviour, the both-directions leak test, and the version-skew guard.
