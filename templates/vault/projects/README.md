# `projects/` — raw, immutable (auto-memory)

**What lives here:** one folder per Claude Code project, each a symlink into that
project's memory dir (`~/.claude/projects/<encoded-path>/memory/`). These are the
memories Claude's auto-memory writes as you work — feedback, decisions, references.

**Rules:**
- **Raw and immutable.** Never hand-edit files here. Only `wiki/` is mutable.
- Symlinks dangle when a project's working dir changes. Run
  `bash scripts/refresh-project-symlinks.sh` before every `ingest` (a broken
  symlink is skipped *silently* under `find -L`).
- Files with `wiki_ingest: false` in frontmatter are operational state and are
  skipped by `ingest`.

This folder is `.gitignore`d — your memories are private.
