# Second Brain Kit — vault schema + operations

This file tells any Claude Code session running in this vault how it is
organized and what to do when you ask. It is the transferable core of the kit —
the method, not the data. Values in `{{DOUBLE_BRACES}}` come from `config.yaml`.

## Layout

- `projects/*/*.md` — **RAW, immutable.** Written by Claude's auto-memory in each
  project. Each folder under `projects/` is a symlink into a project's memory dir
  (`~/.claude/projects/<encoded-path>/memory/`), so files appear flat inside the
  project folder.
- `slack/*.md` — **RAW, immutable.** Forward-sync daily notes (`sync slack`).
- `slack/.last-sync` — ISO timestamp of the most recent Slack message `ts` synced.
- `linear/{issues,projects,initiatives,docs}/*.md` — **RAW, immutable.**
  Forward-sync (`sync linear`), scoped to team `{{LINEAR_TEAM}}` with a rolling
  re-fetch window.
- `linear/.last-sync` — ISO timestamp of the most recent Linear `updatedAt`.
- `notion/{pages,databases}/*.md` — **RAW, immutable.** Forward-sync
  (`sync notion`), scoped to pages you created / last-edited / commented-on /
  were @-mentioned in, plus a watched-databases allowlist. UUID filenames.
- `notion/.last-sync` — ISO timestamp of the most recent Notion `last_edited_time`.
- `notion/.allowlist` — JSON of watched databases (`{database_id, name, signal_type}`).
- `notion/.user-id` — cached owner Notion user UUID.
- `wiki/` — **LLM-MAINTAINED.** The only layer mutated by ingest.
- `config.yaml` — your scope + taxonomy. `CLAUDE.md` reads it for every op.
- `scripts/` — helper scripts (symlink refresh, linkrot lint).

## Wiki structure

One folder per entity type in `{{WIKI_SECTIONS}}` (see `config.yaml`). The
default set (partners, systems, integrators, problems, people, incidents,
initiatives, principles, concepts, workflows, customers) suits a partnerships /
solutions-architecture function — swap it for yours. Plus:

- `wiki/index.md` — catalog of every page, grouped by section.
- `wiki/log.md` — append-only record of every ingest / sync / lint.

**Promotion thresholds** (when a raw mention earns its own page — tune in config):
- Most entity types: **≥ `{{PROMOTION_MIN_SOURCES}}` raw sources** (default 3).
- External people (partner/vendor DRIs): **1 substantive thread** sufficient.
- Internal people: promote only on direct engagement (you @-mentioned/assigned
  them, or shared a thread) — not mere mention.
- `concepts/` — a term referenced **≥3×** across raw with no explainer yet.
- `workflows/` — a how-to reconstructable from raw that saves future-you time.
- `customers/` — an incident OR ≥3 substantive mentions; else tag-only.

**Tag namespaces (locked):** only the namespaces in `{{TAG_NAMESPACES}}`
(`config.yaml`). Don't invent new ones; expand only when a memory truly doesn't
fit. Lint flags out-of-namespace tags.

## Wiki page frontmatter

```yaml
---
name: <short title>
type: wiki
wiki_type: <one of your wiki.sections, singularized>
tags: [<from your locked namespaces>]
sources: [<raw file paths this page synthesizes>]
updated: YYYY-MM-DD
---
```

Body template + link conventions: see `templates/wiki-page.template.md`. Rules:
wiki→wiki and wiki→raw links are `[[wikilinks]]` (no markdown `[text](path)`
links — wikilinks build the graph). Every page ends with a `## Sources` section
listing every raw file it synthesizes. `type: wiki` always — never a memory type
(`feedback|project|user|reference`), or pages leak into memory views.

---

## Operations

**Time source — read before any op.** Every op (`sync *`, `ingest`) derives its
timestamps from `date -u` at the moment it runs. **Never** trust a
`<currentDate>` reminder or conversational memory of "today" — those drift on
long sessions. First action in every op:

```bash
START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
```

Use `$START` for the rolling-window upper bound, watermark writes, and log-entry
timestamps. If `<currentDate>` and `$START` disagree, trust `$START`.

### Orchestration SOP (optional — for multi-agent runs)

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

### Sync (Slack)

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

### Sync (Linear)

When you say **"sync linear"**:

1. **Threshold.** Default last **`{{LINEAR_WINDOW}}`** days, always. Effective
   threshold = MIN(window_start, watermark). Overrides accepted.
2. **Watermark:** `linear/.last-sync` (most recent `updatedAt`). In-window files
   always overwritten; watermark advances forward only.
3. **Fetch** via your Linear MCP, `orderBy: "updatedAt"`, `limit: 50`, paginate
   fully. Scope to team **`{{LINEAR_TEAM}}`**:
   - **Projects:** active set (open statuses) + closed-recent set (completed/
     canceled within ~90 days). Filter client-side on status; don't pass a buggy
     `state` param. Don't request milestones inline (complexity overflow).
   - **Issues:** union of project-scoped (per in-scope project) + personal
     (`assignee: "me"`). Dedupe by issue ID.
   - **Initiatives** and **Documents:** workspace-level; narrow at ingest.
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

### Sync (Notion)

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

### Ingest

When you say **"ingest":**

**No scoped ingests.** Every `ingest` walks **all** source classes. If a class
has zero new files, the log says so explicitly (`notion/pages=0`). Scoped
ingests cause silent gaps when a different class gets writes between passes.

**Step 0 (first action):** `START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")`. Use it for
the watermark write and the log header — don't type a guessed timestamp.

1. **Read the watermark** from `wiki/.last-ingest` (single-line ISO-8601 UTC).
   Missing file = bootstrap (treat as epoch). Do **not** derive the watermark
   from the last log header — headers are display-only labels.
2. **Preflight + delta walk.** Run `bash scripts/refresh-project-symlinks.sh`
   first (a dangling `projects/*` symlink is skipped *silently* under `find -L`,
   so `projects/=0` can look normal but isn't). Then list files newer than the
   watermark:

   ```bash
   find -L projects slack linear notion -type f -name "*.md" \
     -newermt "$(sed 's/Z$//; s/T/ /' wiki/.last-ingest)"
   ```

   Both `sed` substitutions are required on BSD `find` (macOS):
   - `s/Z$//` strips the trailing `Z` — BSD `find` silently rejects the `Z` and
     returns **zero** matches with no error.
   - `s/T/ /` replaces the `T` separator with a space — with the `T` form BSD
     `find` mis-parses and **under-filters wrong**, pulling in already-ingested
     files (looks like legit work, silently re-folds stale content). This is the
     more dangerous failure — it returns *too many*, not zero.

   **Sanity-check the delta:** if a class shows far more files than sync wrote,
   the cutoff is mis-parsing — re-derive it.
3. **For each new raw file:** read it; **skip if `wiki_ingest: false`**;
   determine which wiki pages it touches (tag overlap + content); update those
   pages (append content under new sub-headings, add the raw path to `sources:`,
   bump `updated:`); **create new pages per the promotion thresholds**.
   **Source-balance (soft):** every new page should ideally cite ≥2 source
   classes; if only one is possible, write it anyway and flag `[source-balance]`
   in the log.
4. **Append one entry to `wiki/log.md`:**

   ```
   ## [YYYY-MM-DD HH:MM] ingest | <one-line summary>
   Deltas walked: projects/=N, slack/=N, linear/issues=N, linear/projects=N, linear/initiatives=N, linear/docs=N, notion/pages=N, notion/databases=N
   Sources touched:
   - <raw file>
   Wiki pages updated:
   - wiki/<path>.md
   ```

   The `Deltas walked:` line is **mandatory** — a class showing `=0` is fine; a
   class *absent* from the line is the silent-skip footprint.
5. **Update the watermark.** Write `$START` to `wiki/.last-ingest`, **last**,
   after all writes + the log entry. If anything fails earlier, leave the
   watermark so the next run re-walks.

**Wiki ingest opt-out (`wiki_ingest: false`):** operational-state memories opt
out — resume markers, dev-env notes, gates config, temporary scaffolds. Default
(absent or `true`) means ingest it.

### Query

When you ask a question:

1. Read `wiki/index.md` to orient.
2. Read the most relevant wiki page(s).
3. Drill into raw (`projects/`, `slack/`, `linear/`, `notion/`) only if the wiki
   has a gap or you need specifics it doesn't cover.
4. If the answer is a useful new synthesis (a cross-entity comparison, a pattern
   across problems), offer to file it as a new wiki page.

### Lint

When you say **"lint"**, report (don't auto-fix without approval):

1. **Orphans** — pages with zero inbound wikilinks.
2. **Stale** — pages whose sources are newer than the page's `updated:`.
3. **Contradictions** — claims in two pages that disagree.
4. **Missing cross-refs** — entity mentioned on page A but not linked from pages
   that mention it.
5. **Missing pages** — a tag appearing 3+ times across raw with no page yet.
6. **Source-balance** — pages citing only one source class (sometimes legit).
7. **Graph orphans** — pages with no outbound wikilinks beyond boilerplate.
8. **Tag violations** — tags outside your locked namespaces (catches typos).
9. **Dead / malformed links** — wiki→wiki or wiki→raw links that don't resolve;
   dangling `projects/*` symlinks. Mechanical half: `bash scripts/linkrot-lint.sh`.
10. **Unlinked live project memories** — a memory dir with no `projects/*`
    symlink (⇒ never ingested). Fix: `bash scripts/refresh-project-symlinks.sh`.

## Rules

- **NEVER edit files under `projects/`, `slack/`, `linear/`, or `notion/`.** Only
  `wiki/` is mutable. Raw is raw.
- **Preserve existing `sources:` entries** on updates; append, don't replace.
- **Wiki frontmatter uses `type: wiki`** — never a memory type.
- **Use the locked tag vocabulary.** Don't invent namespaces.
- **Sync/ingest/lint specs are literal** — no editorial discretion, no "minimal
  touch", no condensing of raw content. If you can't follow the spec, stop and
  report; don't silently shortcut. Editorial compression by a sync agent is a
  hand-edit by another name.
- **Wiki pages will occasionally disagree with raw.** Feature, not bug — lint
  surfaces it, you decide. Never silently edit raw to match the wiki.
- **Outbound comms go through the review gate** (`config.yaml` → `outbound_gate`;
  rules in `wiki/principles/outbound-voice.md`). Never post directly.
