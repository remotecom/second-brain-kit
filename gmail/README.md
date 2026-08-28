# `gmail/` — raw, immutable (Gmail forward-sync) — **DISABLED**

> **Status: spec landed, op disabled.** `sources.gmail.enabled: false`. Nothing
> writes here yet. The blocker is **authorization, not design**: the Gmail
> connector returns `Insufficient scope` — it is registered on the account but
> holds no `gmail.readonly` / `gmail.metadata` / `gmail.labels` grant. Re-auth
> in `/mcp`, then follow the three-step enabling checklist in CLAUDE.md
> § Sync (Gmail). One of those steps raises `person_external_min` and **must**
> land in the same change, or the first ingest floods `wiki/people/`.
>
> This directory exists so the raw-class list, `.gitignore`, `delta-walk.sh` and
> the ingest `Deltas walked:` line already carry the class. It reports
> `gmail/threads=SKIPPED-not-implemented`, never `0` — a silent zero is
> indistinguishable from a working source with an empty delta.

The design below is already settled; these are connector facts, not preferences.


**What lives here:** nothing yet. When `sync gmail` is built it will write
`threads/`, **one file per thread**, not per day, named
`YYYY-MM-DD-<subject-slug>-<shortid>.md` (first-message date, so the name is
stable as the thread grows). Deliberately not bare thread IDs: Gmail is the
largest raw class by file count and a graph view of opaque hex is unusable. Email threads run for months; a daily file would tear a
single conversation across two files and the wiki would then cite two halves of
it. Rewriting the thread file when a new message lands is the self-healing
mechanism.

**Rules:**
- **Raw and immutable.** Never hand-edit.
- `gmail/.last-sync` — watermark (most recent message `date`).
- Bodies are fetched as `PLAIN_TEXT`; the connector's `FULL_CONTENT` default
  returns HTML and will exhaust context.
- Quoted reply chains and signatures are stripped — the plaintext body re-embeds
  the whole chain in every message, so a 20-message thread would otherwise store
  the conversation twenty times.
- No attachment bodies.
- The **sensitivity denylist** (`exclude_labels`, `exclude_categories`) is
  applied at fetch time. This is a personal mailbox; excluded mail never reaches
  disk. Exclusions are counted in the sync report.

**Known limits (connector, not choice):**
- `after:` is date-granular (`YYYY/MM/DD`) and cannot express a timestamp, so the
  precise threshold is re-applied client-side per message.
- `search_threads` documents no ordering guarantee, which constrains how
  truncation can be handled safely.

This folder is `.gitignore`d — your mail is private.
