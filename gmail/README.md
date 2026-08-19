# `gmail/` — raw, immutable (Gmail forward-sync)

**What lives here:** `threads/` — written by `sync gmail`, **one file per
thread**, not per day. Email threads run for months; a daily file would tear a
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
