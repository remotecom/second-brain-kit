# Setup: from clone to first answer in about 30 minutes

## 0. What you need

- macOS and Node 18 or newer (`node --version`).
- [Claude Code](https://claude.com/claude-code), logged in with your
  **claude.ai account** (`claude auth status` shows `"authMethod": "claude.ai"`).
  An API key does not work: the bots reach your sources through claude.ai
  connectors, which exist only under a claude.ai login.
- Optional: [Obsidian](https://obsidian.md) for the graph view.

The bots use your claude.ai plan. There is no per-call charge, but they share
your plan's usage limits with you. `usage_share` in `config.yaml` (light,
normal or heavy) caps how much of a day they may use.

## 1. Install

```bash
git clone https://github.com/remotecom/second-brain-kit.git ~/second-brain-kit
~/second-brain-kit/app/bin/second-brain setup --vault ~/SecondBrain
```

Setup asks for your name, work email and Slack member ID (Slack → your
profile → *More* → *Copy member ID*). Then it:

1. checks macOS, Node and the Claude Code login,
2. creates the vault folder: raw source folders, an empty wiki, `config.yaml`,
   a `.gitignore` that keeps your data out of git, and the kit's block in
   `CLAUDE.md`,
3. starts the app at login (a LaunchAgent, `dev.secondbrain.app`),
4. lists anything that still stops the bots, with the fix.

Run setup again at any time. It only adds what is missing; it never changes a
file that exists.

**The vault is private.** Keep it outside the kit folder (setup refuses a
vault inside it). The kit is public code; your vault is your data.

## 2. Connect your sources

The bots use the claude.ai connectors on your account.

1. Open claude.ai → Settings → Connectors.
2. Connect Slack, Linear, Notion, Google Calendar and Google Drive (only the
   ones you want).
3. In the app, open **Checks → Health** and press Run. Each source shows
   `ok`, or the exact fix.

Turn a source off with `enabled: false` under `sources.<name>` in
`config.yaml`. The Morning run then skips it and says so.

## 3. Set your scope

Edit `config.yaml` in the vault (every key is explained in the kit's
`config.example.yaml`):

- `sources.linear.scope`: ONE of `initiative` (a Linear initiative ID; its
  whole sub-tree is synced) or `team` (a team key such as `ENG`).
- `sources.gcal.calendars`: the calendars to sync. Start with your own work
  calendar. Syncing everything readable would pull in colleagues' calendars.
- `sources.gdrive.exclude_folders` / `exclude_folder_titles`: folder trees that
  never sync. The Google Meet trees are excluded by default.
- `owner.timezone`: day files and the Morning run use it.

Read the **sensitivity denylist** in the vault's `CLAUDE.md` before you turn on
Calendar or Drive. Exclusions apply at fetch time, so excluded content never
reaches the disk.

## 4. First run

In the app, press **Run** on the Morning run (or on one sync at a time). The
first run of each source back-fills `bootstrap_days` (default 7) of history
once; after that the rolling window takes over.

After the first run:

- **Today** shows the Brief and anything waiting on you.
- **Resolve** shows questions Verify could not settle alone. Answer them in
  the app (or tick them in `Needs-You.md` in Obsidian).
- The Morning run repeats every day at `schedule.morning_at`.

## 5. Ask questions

Open the vault folder in Claude Code (`cd ~/SecondBrain && claude`), in
Cowork, or in Obsidian. The vault's `CLAUDE.md` tells any Claude session how
the vault works, and that the app owns the syncs and ingest. Ask anything:

```
what do we know about <topic>?
```

## If something is wrong

```bash
~/second-brain-kit/app/bin/second-brain doctor
```

It prints what stops the bots, and the fix for each item. The app's Today page
shows the same list, with a Repair button for missing folders and files.

## Note on Claude Code memory

Claude Code keeps each project's memory in `~/.claude/projects/…/memory`. The
kit links those folders INTO the vault (`projects/`), so your memories live in
the vault and are ingested like any other source. Verify checks the links every
run.
