# `notion/` — raw, immutable (Notion forward-sync)

**What lives here:** `pages/` and `databases/` — written by `sync notion`. Scoped
to pages you created / last-edited / commented-on / were @-mentioned in, plus a
watched-databases allowlist you define in config. UUID-based filenames.

**Rules:**
- **Raw and immutable.** Never hand-edit.
- Content-hash skip: unchanged files are not rewritten.
- `notion/.last-sync` — watermark (most recent `last_edited_time`).
- `notion/.allowlist` — your watched databases (bootstrapped on first run).
- `notion/.user-id` — cached Notion user UUID.

This folder is `.gitignore`d — your Notion content is private.
