# `linear/` — raw, immutable (Linear forward-sync)

**What lives here:** `issues/`, `projects/`, `initiatives/`, `docs/` — written by
`sync linear`, scoped to your configured team (`sources.linear.team_key`) plus
anything assigned to you. UUID-based filenames (stable across renames).

**Rules:**
- **Raw and immutable.** Never hand-edit.
- Content-hash skip: unchanged files are not rewritten (mtime stays put).
- `linear/.last-sync` is the watermark (most recent `updatedAt` synced).
- Comments are expanded on every issue (the Linear analog of Slack thread
  expansion) — mandatory, not heuristic.

This folder is `.gitignore`d — your Linear content is private.
