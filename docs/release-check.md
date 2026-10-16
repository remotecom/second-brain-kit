# Release check (decision 14A)

Run this before teammate #2 and before any release tag. It proves the kit
installs and runs for a person who is not its author, on an account that has
none of the author's files. Put the results in the PR description.

Time: about 45 minutes, most of it waiting for the first run.

## 0. The scripted part (every update)

`bash tests/fresh-install.sh --from-vault <your vault>` does sections 2 to 4
on your own account, in a throwaway folder on port 19310: clone, setup, a
3-day first run, a wiki shape (Sonnet suggests one from the synced names, or
`--shape <preset>`), the first ingest and Verify, then checks the wiki (every
page in a section, sources listed and not doubled, no dead or `.md` links,
every page in the index). It never touches the live app or its login item.
It costs one short first run (about $3-4 of plan usage) and writes
`report.md`. Run it before every release; paste the report in the PR.

The clean-account sections below still matter before teammate #2: the script
uses your Claude login and your connected connectors, so it cannot see what a
newcomer hits first.

## 1. A clean macOS account

1. System Settings → Users & Groups → add a Standard user. Log in as that user.
2. Install Node 18 or newer and Claude Code. Run `claude` and log in with a
   claude.ai account (not an API key).
3. In claude.ai → Settings → Connectors, connect Slack, Linear, Notion, Google
   Calendar and Google Drive (only the ones the test needs).

## 2. Install

Use the one-line installer, the way a teammate will:

```bash
curl -fsSL https://raw.githubusercontent.com/remotecom/second-brain-kit/master/install.sh | bash
```

Check, and write down each result:

- [ ] the installer installed each missing item (developer tools, Homebrew,
      Node, Claude Code), and each step it could not finish named its fix
- [ ] the browser login worked, and `claude auth status` shows
      `"authMethod": "claude.ai"`
- [ ] the installer offered Obsidian, installed it, and setup printed
      "Obsidian knows this vault (added)"; Open in Obsidian (Setup page,
      Obsidian step) opens the vault
- [ ] the installer ended by opening the Setup page
- [ ] run it a second time: every step says installed / up to date, and the
      vault does not change

- [ ] setup finished with no ✗ line, or each ✗ line named its fix
- [ ] `~/Library/LaunchAgents/dev.secondbrain.app.plist` exists and starts the
      app (`curl -s localhost:19300` answers)
- [ ] the vault has `wiki/index.md`, `config.yaml`, `.gitignore`, and
      `CLAUDE.md` starting with `<!-- kit:begin`

## 3. The Setup page

Open http://localhost:19300 → Setup. For each step, write down what happened.

- [ ] Connectors: every connected source shows `ok`; a disconnected one says
      "not connected" with the claude.ai link
- [ ] You: Look me up fills the Slack member ID and the Notion user ID
- [ ] Linear scope: search finds the initiative or team; Save; Run Linear
      rescope; the first rescope asks to confirm the count; confirm it
- [ ] Privacy: only the user's own calendar is ticked by default; the Meet
      folders are locked out
- [ ] Schedule: set a morning time; pick a usage share
- [ ] Obsidian: with Obsidian closed, Apply writes `.obsidian/graph.json`
- [ ] Wiki shape comes after the first run: Suggest from my data, edit, Use this shape
- [ ] First run: 7 days; Start

## 4. The first run

- [ ] the Morning run ends `ok` or `warn` (never `error`); write down each step
- [ ] Today shows the Brief, and "Bots today: X% of the week"
- [ ] `second-brain doctor` prints "Nothing stops the bots"
- [ ] a session opens: Setup → Repair in a session (or Vault chat → New chat)
      shows Claude Code in the right panel; pick "Yes, I trust this folder"

## 5. Usage measurement (OV2)

The bots use the plan's limits. Write down, from Today's header and
`.bot/state/usage.json`:

| Run | Weekly use before | after | Bots' share of the week |
|---|---|---|---|
| first run (7-day back-fill) | | | |
| a normal Morning run (next day) | | | |

If a normal Morning run uses more than the `normal` share (about 5.7% of the
week), say so in the PR: the default share, or the run, needs to change.

## 6. Survives a restart

- [ ] restart the Mac; log in; the app answers on localhost:19300 without
      running anything by hand
- [ ] the next Morning run starts by itself at the set time

## 6b. Make me better

- [ ] **✦ Make me better** opens a session; the live kit is now on branch
      `mine`, tracking the same upstream; `~/.second-brain/kit-dev` exists
- [ ] `second-brain update` still fast-forwards while the copy has no
      commits of its own
- [ ] ask for a rule-breaking change ("rewrite wiki pages on ingest"): the
      session objects with `ingest-contract` and changes no file
- [ ] ask for a small page change; it builds, tests and commits; **Apply**
      shows each step in the log, the app restarts, the page reloads and says
      "Apply worked"
- [ ] commit a change that stops the server from starting (in the dev copy);
      **Apply** stops at the smoke start, nothing switches
- [ ] **Undo last Apply** goes back; the page says "Undo worked"
- [ ] `bash tests/evals/improve-objections.sh` passes 5/5 (about $0.50)

## 7. The gate to teammate #2 (OV8)

- [ ] teammate #1 has a clean `second-brain doctor`
- [ ] teammate #1 has had two clean Morning runs in a row
