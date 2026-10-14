# Second Brain Kit: sync specs

The Second Brain app writes this file from the kit template and `config.yaml`.
Do not edit it: the next update replaces it. It holds the sync specs that
`CLAUDE.md` points to. They are here, not in `CLAUDE.md`, so each session does
not load them. **The app runs these syncs.** Read this file only when the owner
asks you to run a sync op by hand, and follow the lock rule in `CLAUDE.md` first.

**Time source.** Every op starts with `START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")`.
Never trust a `<currentDate>` reminder.

## Orchestration SOP (optional — for multi-agent runs)

If you run sync/ingest as multi-agent workflows, use a **fixed, small fan-out**
and scale the work *per agent*, never the agent *count*. A bigger delta means
each agent does more, not that you spawn more. Guideline shape:

- **Sync = ~5 agents**, three concurrent branches: Slack (1 agent, whole window
  — never per-day, which misplaces cross-day thread replies), Linear (2:
  scope-discovery + issues/comments; initiatives + docs), Notion (2: discovery;
  fetch).
- **Ingest = 1 planner + ⌈target_pages / 3⌉ writers** (cap ~8). Planner clusters
  the delta into DISJOINT target pages; each writer owns ~3 pages so parallel
  writes never collide.
- Cheap model for mechanical fetch/write; strong model only for the ingest
  planner's clustering judgment.
- The main loop keeps the watermark writes, verification gates, the `log.md`
  entry, and the `.last-ingest` advance — agents return manifests, the main loop
  gates and commits.

Single-context runs are fine too; the ops below are written to run either way.

## Sync contract (every source)

Each `sync <source>` op below states only its **deltas** from this contract.

```
 0. START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
 1. threshold = MIN(window_start, watermark)
    └─ no <source>/.last-sync? ⇒ FIRST-ENCOUNTER BOOTSTRAP over
       bootstrap_days (config.yaml), then rolling window forever after
 2. discovery call — cheap metadata only, no bodies
 3. PRE-FETCH SKIP — compare each id's freshness signal against
    <source>/.state.json; unchanged ⇒ skip the body fetch entirely
 4. detail fetch for survivors only
 5. apply the SENSITIVITY DENYLIST, then content-hash → WRITTEN | SKIPPED
 6. VERIFICATION GATE — every WRITTEN file has mtime > $START. If any didn't
    update, do NOT advance the watermark; report the gap and redo.
 7. advance the watermark (forward only)
 8. report: intended / written / skipped / excluded / truncated
```

The content-hash in step 5 saves the *write*. Step 3 is what saves the *fetch* —
without it a rolling window re-downloads every body every run to discover that
nothing changed.

**Documented exceptions** (stated here so they aren't discovered as bugs):
- **Slack** has no content-hash skip — the daily-file overwrite *is* its
  self-healing mechanism. Don't add a hash gate.
- **Gmail** must re-apply the threshold client-side; its `after:` operator is
  date-granular (`YYYY/MM/DD`) and cannot express a timestamp.
- **Calendar** has no separate body fetch, so step 3 is a no-op there.
- **Calendar** also has no content-hash skip, for the same reason as Slack —
  the in-window overwrite is what self-heals reschedules and cancellations.

## Sensitivity denylist (Google sources)

`.gitignore` closes exactly one exposure path — the repo. Two remain: raw files
are plaintext that **every Claude session in this vault reads**, and `ingest`
**synthesizes them into wiki pages**. Gmail, Calendar and Drive are personal
accounts that also hold comp, HR, recruiting, medical and private-event content.

Exclusions are declared in `config.yaml` and applied **at fetch time**, so
excluded content never reaches disk:

- **Gmail** — `exclude_labels`, `exclude_categories`
- **Calendar** — skip events with `visibility: private`
- **Drive** — `exclude_folders`

Config-declared, never model judgment, so it is auditable and cannot drift
between runs. **Count exclusions in the sync report** — a silent exclusion is
indistinguishable from a missing sync.

## Sync (Slack)

When you say **"sync slack"** (or "sync", "pull slack"):

1. **Range.** Default: the last **`{{SLACK_WINDOW}}`** days (today + prior),
   always, regardless of watermark — this rolling window self-heals late thread
   replies. Accept overrides (`sync slack since YYYY-MM-DD`, `last 7 days`).
2. **Watermark.** `slack/.last-sync` holds the most recent synced message `ts`.
   Fetch everything inside the rolling window AND anything past the watermark.
   In-window files are always overwritten. Watermark advances only forward.
3. **Fetch** via your Slack MCP: sent messages
   (`from:<@{{SLACK_USER_ID}}> after:… before:…` — use the angle-bracket
   user-ID form; `from:@me` often returns nothing) and mentions
   (`@<you> -from:<you> after:… before:…`). Use detailed mode so reply counts +
   permalinks are visible.
4. **Expand threads.** For every message with `thread_ts` or `reply_count > 0`,
   read the full thread. Group replies under the root; dedupe by `ts`.
   **Mandatory for every parent with replies** — don't rely on
   `context_before/after` as a thread substitute.
5. **Write per-day files** `slack/YYYY-MM-DD.md` (overwrite if re-syncing). Two
   sections: `## Sent Messages` and `## Mentions & Tags`, each entry timestamped
   with channel + permalink, `<@Uxxx>` resolved to real names, threads indented.
6. **Verification gate (before advancing the watermark).** Confirm every
   in-window daily file has mtime newer than `$START`. If any didn't update
   (silent write failure), **do not advance the watermark** — report the gap and
   redo. Skipping this gate is how data gets lost.
7. **Watermark.** Only after the gate passes, write MAX `ts` seen to
   `slack/.last-sync`.
8. **No content-hash skip for Slack — by design.** Unlike Linear/Notion, Slack
   daily files are always rewritten on in-window re-fetch; the overwrite *is*
   the self-healing mechanism. Don't add a hash gate here.
9. **Report:** sent count, mention count, threads expanded, range, per-file mtime
   confirmation, watermark set. Offer to `ingest`.

## Sync (Linear)

When you say **"sync linear"**:

1. **Threshold.** Default last **`{{LINEAR_WINDOW}}`** days, always. Effective
   threshold = MIN(window_start, watermark). Overrides accepted.
2. **Watermark:** `linear/.last-sync` (most recent `updatedAt`). In-window files
   always overwritten; watermark advances forward only.
3. **Fetch** via your Linear MCP, `orderBy: "updatedAt"`, `limit: 50`, paginate
   fully. Scope: **{{LINEAR_SCOPE}}**.
   - **Initiative scope:** the scope set is cached in
     `linear/.initiative-scope.json` (the app's Rescope builds it).
     `list_projects(initiative: <id>)` returns the whole sub-tree, but only if
     you paginate to exhaustion: page 1 alone looks like a valid scope and is
     not. `initiative.projects` on a `get_initiative` response is DIRECT
     attachment only. Do not pass `team:` with an initiative scope.
   - **Team scope:** the team's projects, all statuses.
   - **No status filter** on projects. Membership in the scope is the test.
     Don't pass the `state` param (buggy) or request milestones inline
     (complexity overflow). `list_projects` does not honor `orderBy`: never
     stop paging early.
   - **Issues:** union of project-scoped (per in-scope project) + personal
     (`assignee: "me"`). Dedupe by issue ID. `list_issues` cuts long
     descriptions with a "(truncated, use `get_issue` …)" marker: call
     `get_issue` for every one of those before writing.
   - **Initiatives:** the scope tree. **Documents:** keep only those whose
     project or initiative is in scope.
4. **Expand comments.** `list_comments` on **every** issue (the Linear analog of
   Slack thread expansion — mandatory, cheap, prevents missing late comments).
5. **Write per-resource files with content-hash skip.** Build the would-be
   content, SHA-256 it against the file on disk; if it matches, **skip the
   write** (mtime untouched, `SKIPPED`); else write (`WRITTEN`). No per-file
   "synced at" line (it would defeat the hash check). Filenames: issues by
   identifier (`<TEAM>-123.md`), others by UUID. Frontmatter carries
   `updated_at` for freshness.
6. **Verification gate:** every `WRITTEN` file has mtime > `$START` (SKIPPED
   exempt). If a `WRITTEN` file is stale, don't advance the watermark.
7. **Watermark:** MAX `updatedAt` seen.
8. **Report:** counts per resource type (intended / written / skipped), comments
   expanded, range, watermark. Offer to `ingest`.

## Sync (Notion)

When you say **"sync notion"**:

1. **Threshold.** Default last **`{{NOTION_WINDOW}}`** days, always. Overrides
   accepted.
2. **Watermark:** `notion/.last-sync` (most recent `last_edited_time`).
3. **Resolve user ID.** Read `notion/.user-id`; else look up your user and cache
   it. Required for created/edited-by signals.
4. **Fetch — union of four signals, deduped by page `id`:** (a) created-by-you,
   (b) last-edited-by-you, (c) @-mention text search for your name, (d) watched
   databases from `notion/.allowlist`. On first run with no allowlist, bootstrap:
   search your configured `watched_databases` by name, confirm, persist. For a
   watched DB's first encounter, query all rows once; afterward filter
   incrementally on the window. Cap very large DBs (>500 rows) — stay incremental
   and note it.
5. **Expand comments.** `notion-get-comments` on **every** page in the union.
6. **Fetch content.** Top-level blocks per page (don't recurse into child pages
   in v1 — they land in their own files if you touched them).
7. **Write per-resource files with content-hash skip** (same discipline as
   Linear). UUID filenames; title in frontmatter; `in_scope_reasons` records why
   each page was pulled.
8. **Verification gate:** `WRITTEN` files have mtime > `$START`.
9. **Watermark:** MAX `last_edited_time` seen.
10. **Report** per-signal counts, comments expanded, written vs skipped,
    watermark. Offer to `ingest`.

**Notion MCP caveats:** pagination uses `start_cursor`/`next_cursor`; @-mention
search is best-effort (fall back to your display name); some data-source queries
need `data_source_id`, not `database_id` (resolve + cache in the allowlist).

## Sync (Google Calendar)

When you say **"sync gcal"** (or "sync calendar"):

1. **Range.** The last **`{{GCAL_WINDOW}}`** days of **event** time (today +
   prior), **always, regardless of watermark** — the same rolling-window rule as
   Slack. Accept overrides (`sync gcal since YYYY-MM-DD`, `last 14 days`).

   **Why not incremental:** `list_events` filters on `startTime`/`endTime`, which
   are the *event's* time, not its modification time, and this connector exposes
   no `updatedMin`. Asking "what changed since last sync" is therefore impossible.
   That is fine — it is the same trade Slack already makes. Re-fetching the window
   wholesale and overwriting **is** the self-healing mechanism. Do not try to
   invent an incremental path here.

   **Accepted limitation, state it in the report:** an event edited or cancelled
   *outside* the window is not picked up. Slack has carried the identical
   limitation since day one.

2. **Bootstrap.** No `gcal/.last-sync` ⇒ first-encounter bootstrap: walk
   `bootstrap_days` of event time once, then the rolling window forever
   after.

3. **Watermark.** `gcal/.last-sync` holds MAX event `updated` seen. **Advisory
   only** — the window does the work, exactly as with Slack. Advances forward only.

4. **Calendars — explicit allowlist, never "everything readable."**
   Sync **only** the calendar IDs in `sources.gcal.calendars`. Default is the
   owner's work calendar alone.

   This is not a preference, it is a scope boundary. `list_calendars` on a real
   account returns the owner's **personal** Gmail calendar, **colleagues'**
   calendars they have shared, and org-wide PTO/holiday calendars. Syncing what
   you *can* read would pull the owner's personal life and a coworker's full
   schedule into a work vault, and then into synthesized wiki pages.

   Use `list_calendars` only to *resolve* names to IDs during setup, never to
   enumerate what to sync. Report any readable calendar not on the allowlist as
   "available, not synced" so the omission is visible rather than silent.

5. **Fetch.** `list_events(calendarId, startTime, endTime, eventType: ['DEFAULT'],
   orderBy: 'startTime')`, paginating on `pageToken`.
   **`eventType: ['DEFAULT']` is mandatory** — the connector's default *also*
   returns `FOCUS_TIME`, `OUT_OF_OFFICE` and `FROM_GMAIL`, which fills the vault
   with focus blocks and auto-generated stubs.

6. **Sensitivity denylist.** Skip events with `visibility: private` unless
   `sources.gcal.include_private` is true. Skip declined events unless
   `include_declined`. **Count every exclusion and report the count** — a silent
   exclusion is indistinguishable from a failed sync.

7. **No pre-fetch skip (step 3 of the contract is a no-op here).** `list_events`
   already returns full event bodies; there is no separate detail fetch to avoid.
   Call `get_event` only when an event is truncated in the list response.

8. **Write per-day files** `gcal/YYYY-MM-DD.md`, **overwriting** every in-window
   file. **No content-hash skip** — same rationale as Slack: the overwrite is what
   self-heals reschedules and cancellations. Per event record: time + duration,
   title, organizer, attendees (`displayName` where present, else `email`, each
   with `responseStatus`), location/Meet link, description, and calendar name.
   Resolve Drive links in `attachments[].fileUrl` to `[[gdrive/files/<fileId>]]`
   so a meeting is linked to the document it produced.

   **Descriptions:** record verbatim up to `max_description_chars`. Past the cap,
   truncate and append `[truncated at N chars — full text in the source event]`
   plus `truncated: true` in frontmatter. This is a *declared* cap, not
   discretion: the Rules forbid editorial condensing, so a sync agent may never
   decide per-event that some prose is boilerplate — it may only apply the cap.

9. **Recurring events.** `list_events` expands a series into one instance per
   occurrence. **Record every instance verbatim.** Do **not** judge which repeats
   are "low-information" and do **not** stamp `wiki_ingest: false` onto a raw
   file — that is editorial compression by a sync agent, which the Rules forbid.
   Collapsing repetitive instances is `ingest`'s job, on a mechanical rule
   (identical title with no attendee or description delta vs. the prior instance).

10. **Verification gate (before advancing the watermark).** Every in-window daily
    file must have mtime newer than `$START`. If any didn't update, **do not
    advance the watermark** — report the gap and redo.

11. **Report:** events written, per-day file count, calendars covered, exclusions
    by reason (private / declined / non-DEFAULT type), range, watermark, and the
    out-of-window-edit caveat. Offer to `ingest`.

**Google Calendar MCP caveats:** `list_events` returns event-time-filtered
results only (no modification-time filter); `orderBy: 'lastModified'` sorts
*within* that filtered set and does not widen it. `pageSize` defaults to 100, max
250. There is no deletion feed — a cancelled event vanishes from results rather
than being reported, which the in-window overwrite handles but out-of-window
cancellations do not (lint check 11).

## Sync (Google Drive)

When you say **"sync gdrive"** (or "sync drive"):

1. **Range.** Files with `modifiedTime` newer than
   `MIN(window_start, watermark)`, where window = last **`{{GDRIVE_WINDOW}}`**
   days. Unlike Slack/Calendar, Drive *can* filter on modification time, so this
   source is genuinely incremental.

2. **Bootstrap.** No `gdrive/.last-sync` ⇒ walk `bootstrap_days` once.

3. **Watermark.** `gdrive/.last-sync` = MAX `modifiedTime` seen. Forward only.

4. **Discovery — union, deduped by `id`:**
   - `search_files("owner = 'me' and modifiedTime > <T>")`, paginate `pageToken`.
   - `list_recent_files(orderBy: 'lastModifiedByMe')` — **has no time filter**
     (only `pageSize`/`pageToken`), so page until results fall older than `T`,
     under a hard page ceiling. `lastModifiedByMe` is *not* a searchable field;
     this sort order is the only way to reach that signal.
   - Watched folders: `search_files("parentId = '<id>' and modifiedTime > <T>")`.
     **`parentId` does not recurse** — a watched folder does not include its
     subfolders. Enumerate subfolders explicitly if you need them.

5. **Filter, in this order, counting each rejection:**
   - **`exclude_folders`** (by `parentId`). Default excludes **"Meet Recordings"**.
     That folder holds Meet artifacts: `video/mp4` recordings, `text/plain` chat
     logs, and auto-generated "Notes by Gemini" docs. The Gemini docs are the
     reason this exclusion exists — they are frequently pure boilerplate
     ("A summary wasn't produced for this meeting", "No suggested next steps were
     found") and would fill the wiki with empty pages. Excluding by folder is
     declarative and auditable; judging emptiness per document is not allowed.
   - **`mime_allowlist`.** Only types `read_file_content` can actually read:
     Google Docs/Slides/Sheets, MS Office, ODF, PDF. **`text/*` is NOT supported**
     by the connector and would fail. Images (png/jpeg) *are* supported but yield
     useless raw, so they are deliberately absent from the default allowlist.

6. **Pre-fetch skip.** Compare each `id`'s `modifiedTime` against
   `gdrive/.state.json`; unchanged ⇒ skip the body fetch entirely.

7. **Fetch** `read_file_content(fileId, includeComments: true)`.
   **Comments are expanded, like every other source** — they inline into the text
   with thread mapping. Supported for Docs, Slides and Sheets only; note the gap
   for PDFs and Office files rather than implying coverage.

8. **Write** `gdrive/files/<fileId>.md` with content-hash skip. Frontmatter:
   `id`, `title`, `mime_type`, `owner`, `parent_id`, `web_link`, `created_time`,
   `modified_time`, `in_scope_reasons`, `truncated`. Bodies over
   `max_body_chars` truncate with an explicit marker and `truncated: true` — a
   declared cap, never per-document judgment.

9. **Cross-link — only what the source itself contains.** A Drive doc reached
   from a calendar attachment is linked as `[[gdrive/files/<id>]]` from `gcal/`
   because the attachment *is* in the source event. Meeting-notes docs embed
   their own calendar event URL, so record that URL as it appears.

   Do **not** add a `See also:` backlink from the Drive file to `[[gcal/…]]`.
   That link is not in the document — inventing it is synthesis written into the
   immutable layer, the same violation as stamping `wiki_ingest: false` onto raw.
   Rendering a link the source *does* contain is representation; adding one it
   does not is editorializing. Cross-references the source lacks belong in
   `wiki/`.

10. **Verification gate** (every `WRITTEN` file has mtime > `$START`), then
    watermark, then **report**: found / excluded-by-folder / excluded-by-mime /
    pre-fetch-skipped / written / hash-skipped.

**Google Drive MCP caveats:** `search_files` supports only `title`, `fullText`,
`mimeType`, `modifiedTime`, `viewedByMeTime`, `createdTime`, `parentId`, `owner`,
`sharedWithMe` — there is no `lastModifiedByMe` term and no recursion on
`parentId`. `fileSize` on a Google-native doc is not its text length. There is no
change feed, so deletions are invisible until probed (lint check 11).

## Sync (Gmail) — SPEC LANDED, OP DISABLED

**Status: `sources.gmail.enabled: false`. Do not run this op yet.** It is
specified here so its absence is explicit rather than discovered mid-sync, and
so the design is not re-derived (or re-improvised) the day the blocker clears.

**The blocker is authorization, not design.** `list_labels` and `search_threads`
both return `Insufficient scope` — the Gmail connector is registered on the
account but holds no `gmail.readonly` / `gmail.metadata` / `gmail.labels` grant.
Re-authorize Gmail in `/mcp`, confirm `list_labels` returns, *then* enable.

**Every op that walks the class list reports `gmail/threads=SKIPPED-not-implemented`,
never `0`.** A silent zero is indistinguishable from a working source with an
empty delta — the exact failure mode the `Deltas walked:` line exists to catch.
`{{KIT_SCRIPTS}}/raw-classes.sh` carries `gmail/threads` in `RAW_UNIMPLEMENTED` and
`delta-walk.sh` emits this automatically, so this is not something to remember.

### Enabling it — three things land in ONE change, never sequentially

1. **Re-auth the connector** and verify `list_labels` returns real labels. The
   `exclude_labels` denylist is specified by label *ID*, not display name, so
   the IDs must be resolved and written into `config.yaml` before the first
   fetch — not after.
2. **Flip `sources.gmail.enabled: true`** and clear `gmail/threads` from
   `RAW_UNIMPLEMENTED` in `{{KIT_SCRIPTS}}/raw-classes.sh`.
3. **Sweep the prose that describes Gmail as disabled**, all in one pass:
   this section's `— SPEC LANDED, OP DISABLED` heading, the
   `gmail/threads/*.md` bullet in Layout, the `SKIPPED-not-implemented` claim
   just above, the ingest `Deltas walked:` example line, and the banner at the
   top of `gmail/README.md`. None of these is load-bearing (delta-walk.sh reads
   `RAW_UNIMPLEMENTED` at runtime), but each reads as false the day Gmail
   ships, and this checklist exists precisely so the change is one-shot.
4. **Raise `wiki.promotion.person_external_min` from 1 to 2.** At 1, a single
   substantive thread promotes an external person, and Gmail hands
   `wiki/people/` every vendor, recruiter, and one-off contact who has ever
   emailed you. This is not cleanup to do afterwards — the first `ingest` after
   enabling Gmail permanently pollutes the graph, and un-promoting pages is
   manual work the kit has no op for. `config.example.yaml` already ships `2`
   for this reason; the value is only safe at `1` if you never enable Gmail.

### The op (when enabled)

Follows the standard sync contract. Deltas from it:

1. **Threshold.** Last **`{{GMAIL_WINDOW}}`** days; effective threshold =
   MIN(window_start, watermark). Bootstrap over `bootstrap_days`.

2. **Watermark.** `gmail/.last-sync` = most recent message `date` seen. Forward
   only.

3. **Client-side threshold re-apply — mandatory.** Gmail's `after:` operator is
   **date-granular** (`YYYY/MM/DD`) and cannot express a timestamp. Query
   `after:` the threshold's *date*, then discard messages older than the actual
   threshold **per message, client-side**. Skipping this silently re-ingests up
   to a full day of already-synced mail on every run.

4. **Query shape: a bare `after:<date>` window.** Do **not** scope with
   `in:sent` — that was the coverage bug: it drops every thread where someone
   wrote to you and you had not yet replied, which is most of the inbound
   signal. Noise is handled by the denylist (step 5), not by narrowing the query.

5. **Sensitivity denylist, applied at FETCH time.** Drop threads matching
   `exclude_labels` (label IDs) or `exclude_categories` (default:
   `promotions`, `social`, `forums`) **before** any body is fetched, so excluded
   mail never reaches disk. This is a personal mailbox holding comp, HR,
   recruiting and medical content. Config-declared, never model judgment.
   **Count every exclusion and report the count.**

6. **Pre-fetch skip.** Compare each thread `id`'s latest message `date` against
   `gmail/.state.json`; unchanged ⇒ skip the body fetch entirely.

7. **Fetch bodies as `PLAIN_TEXT`.** The connector's `FULL_CONTENT` default
   returns the HTML body as well and will exhaust context on a real mailbox.

8. **Write `gmail/threads/YYYY-MM-DD-<subject-slug>-<shortid>.md` — one file
   per THREAD, not per day.** Email threads run for months; a daily file would
   tear one conversation across two files and the wiki would cite two halves of
   it. Rewriting the whole thread file when a new message lands is the
   self-healing mechanism. Apply the content-hash skip as with Linear/Notion.

   **Not bare thread IDs**, unlike `gdrive/files/<fileId>.md` and
   `notion/pages/<uuid>.md`. Gmail will be the largest raw class by file count,
   and the README sells Obsidian graph view — a graph of opaque hex is unusable.
   The filename rule is mechanical, so it is not model discretion:
   - `YYYY-MM-DD` = the thread's **first** message date, so the file keeps its
     name as the thread grows. Never the latest message date, which would
     rename (and thus duplicate) the file on every reply.
   - `<subject-slug>` = the first message's subject, lowercased, `Re:`/`Fwd:`
     prefixes stripped, non-alphanumerics collapsed to single hyphens, trimmed
     to **40 chars** on a word boundary, then leading/trailing hyphens stripped.
     **If the slug is empty *after* collapsing, use `no-subject`.** Keying the
     fallback off the post-slug result (not the raw subject) is deliberate: a
     subject that is pure punctuation, or entirely emoji or non-Latin script,
     is not empty but collapses to nothing — and a bare `-` would produce a
     leading-hyphen filename that every CLI tool parses as a flag (`grep *.md`
     → `unknown --directories option`), including this vault's own
     `linkrot-lint.sh`. Subjects are attacker-controlled: anyone can email you
     any subject line, so this is input sanitization, not tidiness.
   - `<shortid>` = first **12** chars of the thread ID, and **verify on write**.
     12 hex chars makes an accidental clash vanishingly unlikely, but "unlikely"
     is not "impossible" and the failure is silent data loss: two threads
     sharing a first-message date, a subject-slug *and* an id prefix would
     resolve to one filename, and the content-hash gate would treat the second
     as a legitimate rewrite of the first — overwriting a file this kit calls
     immutable, with no error and a verification gate that passes.
     So before writing, if the target file exists and its frontmatter
     `thread_id` is not this thread, **widen the shortid until it differs**;
     never overwrite a file belonging to another thread.

   **Strip quoted reply chains and signatures.** The plaintext body re-embeds
   the entire preceding conversation in every message, so a 20-message thread
   would otherwise store itself twenty times. This is a mechanical rule
   (quote-prefixed and `On <date>, <person> wrote:` blocks), **not** editorial
   judgment about which prose matters — a sync agent may never decide a passage
   is boilerplate. Bodies over `max_body_chars` truncate with an explicit marker
   and `truncated: true`.

   Frontmatter: `thread_id`, `subject`, `participants`, `message_count`,
   `first_message_date`, `last_message_date`, `label_ids`, `truncated`.

9. **On truncation, narrow the window and re-run — never clamp the watermark.**
   `max_threads_per_sync` is a *self-imposed cost ceiling*, not a connector
   limit: `search_threads` paginates via `pageToken`. So when a run hits the
   ceiling, halve the window, re-run each half, and recurse until every
   sub-window comes back under the cap. Only then advance the watermark to MAX.

   **Base case — mandatory, the recursion does not terminate without it.**
   `after:`/`before:` are date-granular, so a window **cannot be halved below
   one calendar day**: halving a 1-day window returns the same 1-day window and
   recurses forever. So when a sub-window has narrowed to a single day and still
   exceeds `max_threads_per_sync`, **stop halving**: page that day fully via
   `pageToken`, ignoring the cost ceiling, and report it as an `overflow day` in
   the sync report. The ceiling is a cost guard, not a correctness boundary —
   blowing through it for one busy day is correct; looping forever is not.

   **Why not clamp to the oldest thread written.** That presumes the truncated
   result set is contiguous and ordered newest-first. `search_threads`
   documents no `orderBy` and **no ordering guarantee**, so the threads that got
   dropped may be *newer* than the clamp, not older — holes remain above it and
   go permanently unfetched once the rolling window moves past them. An
   unordered result set cannot be bounded by one of its own elements. Report the
   recursion depth and the sub-windows walked, so a pathologically busy window
   is visible rather than silently expensive.

10. **Verification gate** (every `WRITTEN` file has mtime > `$START`), then
    watermark, then **report**: threads found / excluded-by-label /
    excluded-by-category / pre-fetch-skipped / written / hash-skipped /
    truncated.

**Gmail MCP caveats:** `after:`/`before:` are date-granular only. `label:`
accepts label **IDs**, not display names — resolve via `list_labels`. Gmail
matches a thread if *any* message matches, so a negated term (`-is:starred`)
still returns threads containing one non-matching message; re-filter
client-side. There is no deletion feed (lint check 11).
