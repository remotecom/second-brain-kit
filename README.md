# Second Brain Kit

A personal knowledge operating system you run locally with Claude Code. It pulls
your real work surfaces — Slack, Linear, Notion, Google Workspace (Drive, Gmail,
Calendar), and Claude's own project memories — into plain markdown, then synthesizes them into a wiki that
**writes and maintains itself**. Ask it a question, get one authoritative answer
instead of scrolling four tools.

Built for teams who keep re-deriving the same knowledge. Install it, point it
at your sources, and it compounds from there.

## The three layers

1. **Raw sync (immutable).** `sync slack` / `sync linear` / `sync notion` /
   `sync gcal` / `sync gdrive` pull your activity into flat markdown, governed
   by watermarks, rolling re-fetch windows, content-hash idempotency, pre-fetch
   skip state, and verification gates. Each source is on or off in
   `config.yaml`. The model only presses the connector's buttons; code writes
   every raw file.
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

This repo is **code, not data**: the kit scripts, the vault template and the
Second Brain app. Your vault (synced sources, wiki, `config.yaml`) is a
separate private folder that setup creates. It never enters this repo, and the
code holds no partner, customer or personal names.

## Quickstart

You need macOS, Node 18 or newer, and Claude Code logged in with your
claude.ai account.

```bash
git clone https://github.com/remotecom/second-brain-kit.git ~/second-brain-kit
~/second-brain-kit/app/bin/second-brain setup --vault ~/SecondBrain
```

Setup creates the vault, starts the app at login, and checks your install.
Then open http://localhost:19300 and follow **[SETUP.md](./SETUP.md)** to
connect your sources and start the first run.

The app runs the syncs, ingest and checks every morning. You read and ask
questions in the app, in Obsidian, or in Claude Code / Cowork opened on the
vault folder.

## Make it yours

The mechanics (sync/ingest/query/lint, the multi-agent orchestration) are the
same for everyone. Only two things are per-function, both in `config.yaml`:

- **Source scope** — your Linear initiative or team, Slack ID, watched Notion databases,
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

- macOS, Node 18 or newer.
- [Claude Code](https://claude.com/claude-code), logged in with a claude.ai
  account. The bots reach your sources through claude.ai connectors and share
  your plan's usage limits (there is no per-call charge).
- claude.ai connectors for the sources you turn on: Slack, Linear, Notion,
  Google Calendar, Google Drive. (Gmail is not written yet.)
- Optional: [Obsidian](https://obsidian.md) for the graph view.

## Contributing

See [`CLAUDE.md`](./CLAUDE.md) for the repo layout and the rules (no private
names anywhere, config instead of hardcoding). Run `bash tests/run.sh` before
every commit.
