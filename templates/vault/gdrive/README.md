# `gdrive/` — raw, immutable (Google Drive forward-sync)

**What lives here:** `files/` — written by `sync gdrive`. Scoped to files you own
or last edited, plus a watched-folders allowlist. `fileId` filenames (stable
across renames).

**Rules:**
- **Raw and immutable.** Never hand-edit.
- Content-hash skip on write; pre-fetch skip via `gdrive/.state.json` so an
  unchanged file costs no body fetch.
- `gdrive/.last-sync` — watermark (most recent `modifiedTime`).
- `gdrive/.allowlist` — your watched folders.
- Comments **are** expanded (`read_file_content` with `includeComments: true`),
  same as Slack/Linear/Notion. Supported for Docs, Slides and Sheets only.

**Known limits (connector, not choice):**
- `lastModifiedByMe` is not a searchable field — it exists only as a sort order
  with no time filter, so that half of the scope is a bounded paged scan.
- `parentId` does **not** recurse; a watched folder does not include its
  subfolders. List them explicitly.
- Deletions are invisible. There is no change feed, so a deleted file leaves a
  file here until a probe detects the 404. See lint check 11.

This folder is `.gitignore`d — your Drive content is private.
