# Second Brain Kit

A personal knowledge operating system you run locally with Claude Code. It pulls
your real work surfaces (Slack, Linear, Notion, Google Workspace and Claude's
own project memories) into plain markdown, then synthesizes them into a wiki that
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

## Set it up (about 30 minutes)

### Before you start

Have these ready. They save you time on the Setup page.

- **A Mac** and a **claude.ai account**. The bots run on your claude.ai plan
  through Claude Code. An API key does not work.
- **Your sources, connected in claude.ai.** Open claude.ai → Settings →
  Connectors. Connect the ones you want: Slack, Linear, Notion, Google
  Calendar and Google Drive.
- **Your Slack member ID.** In Slack, open your profile → **⋮ More** →
  **Copy member ID**. It starts with `U`.
- **Your Linear scope** (only if you use Linear): one initiative or one team
  key, such as `ENG`.

### 1. Run the installer

Open Terminal and paste this line:

```bash
curl -fsSL https://raw.githubusercontent.com/remotecom/second-brain-kit/master/install.sh | bash
```

The installer checks each part and installs only what is missing. You do
these things yourself when it asks:

1. Click **Install** in Apple's developer-tools dialog (only if it appears).
   This takes about 5 minutes.
2. Type your Mac password once (only if Homebrew is not installed).
3. Log in with your claude.ai account when the browser opens.
4. Answer **Y** or **n** to "Install Obsidian?" (optional; it shows the
   wiki as a graph).
5. Type your name, your work email and your Slack member ID.

At the end, the app opens on its **Setup** page. A **Second Brain** icon is
now in your Dock. The app also starts by itself when you log in.

The installer puts two folders in your home folder:

| Folder | What it is |
|---|---|
| `~/second-brain-kit` | The code (this repo). |
| `~/SecondBrain` | Your vault: your synced data and your wiki. It is private and never goes into git. |

### 2. Do the eight steps on the Setup page

Do them in order. Each step shows **done** when it is complete.

| Step | What you do |
|---|---|
| 1. Connectors | Press **Find my connectors**. Each source shows `ok`, or the fix. Press **Save**. |
| 2. You | Press **Look me up**, check your name, email and Slack ID, and press **Save**. The syncs use them to find your own messages, pages and issues. |
| 3. Linear scope | Press **Load from Linear**. Pick one initiative (with all its sub-projects) or one team. |
| 4. Privacy | Press **Show the preview**. Tick the calendars and the Drive folders to sync. Start with your own work calendar only. Nothing syncs before you save. |
| 5. Schedule | Pick the time for the daily Morning run. |
| 6. Obsidian | Optional. Press **Apply graph colors** to set up the graph view. |
| 7. First run | Pick a back-fill (3 days for a quick try, 7 days by default). Press **Start the first run**. |
| 8. Wiki shape | Pick the sections of your wiki (for example people, partners, systems). Start from a preset, or press **Suggest from my data**. Then press **Use this shape and start the first ingest**. |

The first run takes a while: a longer back-fill takes longer. You can close
the window. The app keeps working in the background.

### 3. Use it

- **Today** shows the daily Brief and the items that wait for you.
- **Resolve** shows questions the checks could not settle alone. Answer
  them there.
- **Ask questions** in a Claude session on the vault
  (`cd ~/SecondBrain && claude`), in the app, or in Obsidian.
- The **Morning run** syncs, updates the wiki and checks it every day.

### Update, repair and more

- **Update:** the app checks for new versions every 6 hours. Press
  **Update** in the app when it shows one. To see what each update brings,
  open **What's new**.
- **Something is wrong:** run `~/second-brain-kit/app/bin/second-brain doctor`.
  It lists each problem and its fix. The Today page shows the same list.
- **Run the installer again** at any time. An existing install only updates.
  It never moves you to a new vault.
- **More detail** on each step, the scope settings and the privacy rules:
  **[SETUP.md](./SETUP.md)**.

<details>
<summary>Install by hand instead of with the installer</summary>

Install each part yourself. `second-brain setup` checks each part and prints
the fix for anything missing.

| What | How to install it |
|---|---|
| Apple's developer tools (git, python3) | `xcode-select --install` |
| Node 18 or newer | `brew install node`, or [nodejs.org](https://nodejs.org) |
| [Claude Code](https://claude.com/claude-code) | `curl -fsSL https://claude.ai/install.sh \| bash` |
| A claude.ai login in Claude Code | run `claude`, then log in with your claude.ai account |
| Optional: [Obsidian](https://obsidian.md) | `brew install --cask obsidian` |

Then get the kit and run setup:

```bash
git clone https://github.com/remotecom/second-brain-kit.git ~/second-brain-kit
~/second-brain-kit/app/bin/second-brain setup --vault ~/SecondBrain
~/second-brain-kit/app/bin/second-brain
```

The last command opens the app on the Setup page. Continue at step 2 above.

</details>

The bots use your claude.ai plan. There is no per-call charge, but they share
your plan's usage limits with you. `usage_share` in the vault's `config.yaml`
(light, normal or heavy) caps their part. Gmail sync is not built yet.

## Make it yours

The mechanics (sync/ingest/query/lint, the multi-agent orchestration) are the
same for everyone. Only two things are per-function, both in `config.yaml`:

- **Source scope:** your Linear initiative or team, Slack ID, watched Notion databases,
  watched Drive folders, and the sensitivity denylist for the Google sources.
- **Wiki taxonomy:** the entity types your synthesis organizes around. The
  defaults suit partnerships / solutions-architecture; swap them for eng
  (services / runbooks / postmortems), BizOps (accounts / processes / vendors),
  PM (features / personas / experiments), etc.

### Change the app itself: Make me better

Press **✦ Make me better** in the app. A Claude session opens on your own
copy of the kit, with the kit's rules (`PRINCIPLES.md`) and recipes
(`docs/framework/`) loaded. It plans with you first and objects, by rule id,
to a change that would break a rule, then offers the nearest version that
keeps it. It builds and tests in a separate dev copy; nothing reaches the
running app until you press **Apply**. Apply runs the tests, starts the new
code on the side, switches over, and goes back by itself if the app does not
come back. **Undo last Apply** (or `second-brain rollback` in Terminal) goes
back one step.

Your changes are yours: nobody reviews them. Once your copy has changes of
its own, `update` no longer pulls; new upstream work is brought in on
purpose.

## The honest part

Day one, this is empty and unimpressive: you are only syncing. The value
**compounds**: a week in you're feeding it, a month in it answers things you'd
forgotten you knew. Give it a few weeks before you judge it.

## Contributing

See [`CLAUDE.md`](./CLAUDE.md) for the repo layout and the rules (no private
names anywhere, config instead of hardcoding). Run `bash tests/run.sh` before
every commit.

## License

MIT. See [`LICENSE`](./LICENSE). The license covers the code in this repo,
not the data in your vault.
