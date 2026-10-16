# Principles

The rules of the Second Brain kit, in one place. Each rule has an id, the
reason it exists, and how it is checked. A Make me better session reads this
file first and objects, by id, to a change that breaks a rule. People and
sessions changing the kit by hand follow it too.

**To change a rule, change this file**, on purpose, as its own commit. Apply
shows an edit to this file separately, before anything else. A rule is never
broken because someone asked twice.

"Check" names what catches a break: a test (`tests/run.sh` section or
`app/test/<file>`), the Apply gate, or `review` when only a person or the
session can judge it.

## Your data

### raw-immutable
**Rule:** Never edit, annotate or delete a file in a raw folder (`projects/`,
`slack/`, `linear/`, `notion/`, `gdrive/`, `gmail/`, `gcal/`). Only `wiki/` is
rewritten. The exceptions write NEW files only: a sync rewrites its own raw
class from the source; `capture` adds files to `projects/cowork/`; Save &
close adds files to `projects/sessions/`.
**Why:** raw is the record of what happened. The wiki is a synthesis of it,
and every wiki claim cites a raw file. Edited raw makes the citations lie.
Sync agents once wrote glosses into raw Slack files; it was found only much
later, and every affected file had to be checked by hand.
**Check:** session deny rules (`app/test/sessions.test.js`, "session deny
rules"); `linkrot-lint.sh` annotation check (`tests/run.sh` sections 2-3);
review.

### raw-purity
**Rule:** Raw is verbatim. No summaries, glosses, `[[wiki links]]`,
"relevant" filtering or reply counts in place of content. Relevance is
ingest's judgment, never the sync's.
**Why:** ingest cannot judge content that was never written down. A sync that
drops "tangential" messages loses them for good.
**Check:** `linkrot-lint.sh` (`tests/run.sh` sections 2-3); review.

### ingest-contract
**Rule:** Ingest walks every raw class every run, reports each class in its
`Deltas walked:` line (`=0` is fine, missing is not), APPENDS to wiki pages
(never rewrites a whole page), and moves the watermark last.
**Why:** a scoped or partial ingest left silent gaps when another class got
writes between passes. Whole-page rewrites lost facts that were only on the
old page.
**Check:** `app/test/ingest-blocks.test.js` (FILE refused for an existing
page; APPEND placement); `tests/run.sh` sections 1, 4, 5b.

### one-driver
**Rule:** The app owns sync, ingest, resolve and restructure. Nothing else
runs them while the app may be running (check `.bot/lock`). Answers in
`Needs-You.md` are the owner's; nothing ticks them for the owner.
**Why:** two drivers writing the same raw files and watermarks at once
corrupt them.
**Check:** session deny rules (`Needs-You.md`, `.bot/**`, watermarks);
review.

### no-private-names
**Rule:** The kit repo is public. No partner, customer, channel, person or ID
names in anything committed, not even in comments or examples. Use generic
ones (acme, globex, jane.doe@example.com).
**Why:** the kit is shared; the vault is private. One leaked name exposes a
partner relationship.
**Check:** `tests/run.sh` section 6 (denylist kept outside the repo).

### outbound-review
**Rule:** Nothing the kit makes is posted to other people automatically.
Drafts go to the owner (a DM to themselves at most); the owner sends.
**Why:** a wrong message to a partner or a channel cannot be taken back.
**Check:** review.

## The machine

### bots-through-claude-call
**Rule:** Every unattended `claude -p` call goes through
`app/lib/claude-call.js`: no setting sources, the kit's bot settings (hooks
off; Bash, Write, Edit, Web and Agent denied), no MCP servers unless the call
needs connectors.
**Why:** one set of safety flags instead of seven copies that drift. Connector
tool definitions cost about 600k tokens per turn when loaded for nothing.
**Check:** `app/test/claude-call.test.js` ("no bot module builds its own
claude flag list" and the others).

### model-presses-code-writes
**Rule:** The model presses buttons (calls tools, returns blocks); code writes
raw files, watermarks, ticks and the switch to new code. A Make me better
session never applies, updates, pushes or restarts anything itself.
**Why:** code can be tested and gated; a model's file write cannot.
**Check:** the Apply gate (`app/lib/apply.js`); improve session settings
(`app/lib/improve.js`); review.

### config-not-hardcode
**Rule:** Anything that differs per person or company comes from
`config.yaml`. A new key goes in `config.example.yaml` with a default and a
comment; migration adds it to existing vaults without changing any value.
**Why:** the same kit runs for different people; a hardcoded value is someone
else's value.
**Check:** `app/test/config.test.js` (round-trip, migrateConfig).

### side-install-stays-side
**Rule:** A test or demo install (`SECOND_BRAIN_STATE_DIR` set) never touches
the Mac-wide state: the Dock app, Claude Code settings, project memory
binding, the real login item.
**Why:** the release check once nearly pointed the owner's real Dock app at a
throwaway copy, and binding could have moved real memories into a demo vault.
**Check:** `app/test/setup.test.js` ("a side install ... never touches the
Mac").

### apply-is-the-gate
**Rule:** A change reaches the running app only through Apply (or `update`
for a copy with no changes of its own). Apply runs the tests, starts the new
code on the side, and rolls back by itself if the app does not come back.
Changes to guard files (this file, the tests, the gate, the runner, the bot
safety flags) are shown to the owner on their own.
**Why:** the person changing the app is often not an engineer, and the
session making the change runs inside the app it changes.
**Check:** `app/test/apply.test.js`, `app/test/kit-git.test.js`.

## How changes are made

### think-before-design-change
**Rule:** For a change that touches data flow, raw layers, ingest, global
settings or recurring cost: list what else it touches (downstream and side
effects, cost, data safety, other code reading the same files), agree the
design with the owner, then build.
**Why:** a feature built straight from a request broke two rules before
anyone looked (rewrite-on-ingest, file-on-close). The analysis found it in
minutes.
**Check:** review (the Make me better session does this first).

### tests-are-not-negotiable
**Rule:** Every change comes with tests. A failing test is fixed, never
deleted or weakened to pass; if a test is wrong, say why and let the owner
decide.
**Why:** the tests are how a non-engineer knows a change is safe.
**Check:** the Apply gate runs the live kit's own tests against the change
and lists any that newly fail.

### plain-words
**Rule:** Text the owner reads (UI, prompts, docs, wiki prose) is about 80%
ASD-STE100 Simplified Technical English: short sentences, common words with
one meaning, one term per thing, active voice, no em dashes.
**Why:** the reader is busy and often not a native speaker of the jargon.
**Check:** review.
