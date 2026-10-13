# Setup: from clone to first answer in about 30 minutes

## 0. What you need

The one-line installer sets up all of this and then runs section 1 for you:

```bash
curl -fsSL https://raw.githubusercontent.com/remotecom/second-brain-kit/master/install.sh | bash
```

Skip to section 2 when it opens the Setup page. To install by hand, you need:

- macOS, with Apple's developer tools (`xcode-select --install`: git and
  python3).
- Node 18 or newer (`node --version`; install with `brew install node` or
  from https://nodejs.org).
- [Claude Code](https://claude.com/claude-code)
  (`curl -fsSL https://claude.ai/install.sh | bash`, or
  `npm install -g @anthropic-ai/claude-code`), logged in with your
  **claude.ai account** (`claude auth status` shows `"authMethod": "claude.ai"`).
  An API key does not work: the bots reach your sources through claude.ai
  connectors, which exist only under a claude.ai login.
- Optional: [Obsidian](https://obsidian.md) for the graph view.

The bots use your claude.ai plan. There is no per-call charge, but they share
your plan's usage limits with you. `usage_share` in `config.yaml` (light,
normal or heavy) caps how much of a day they may use.

## 1. Install (by hand; the installer does this step for you)

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

On the Setup page, step 7, pick a back-fill (3 days for a quick try, 7 by
default) and press **Start the first run**. The first run of each source
back-fills that much history once; after that the rolling window takes over.

The first run syncs, then waits for your **wiki shape** (step 8): the sections
your wiki is built around (accounts, services, partners, and so on). Start
from a preset, press **Suggest from my data** (Claude reads the synced names
and titles and proposes sections, a few cents), or **Talk it through** in a
Claude session. Edit the list, then press **Use this shape and start the first
ingest**. You can add sections later.

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
