#!/usr/bin/env bash
# DEPRECATED 2026-08-03 — superseded by bind-project-memory.sh
#
# This script assumed the OLD link direction: projects/<slug> as a symlink
# pointing OUT of the vault at ~/.claude/projects/<encoded-cwd>/memory. That
# layout is invisible to any runtime sandboxed to the vault directory (Claude
# Cowork, container mounts), which made `find -L projects` return 0 and ingest
# silently report projects/=0.
#
# The direction is now inverted: projects/<slug> is the canonical REAL dir
# inside the vault, and ~/.claude/.../memory is a symlink pointing at it.
#
# Running the old logic against the new layout is DESTRUCTIVE: its `ln -sfn`
# would target a non-empty real directory and create a nested symlink inside
# your memory store. Hence this stub rather than a deletion — anything (a
# stale doc, an old habit, a wiki page) that still invokes this path gets a
# loud redirect instead of a corrupted raw layer.
set -euo pipefail

cat <<'EOF'
refresh-project-symlinks.sh is DEPRECATED and does nothing.

The project-memory link direction was inverted on 2026-08-03 so that dir-scoped
runtimes (Claude Cowork) can see the raw layer. Use:

    bash scripts/bind-project-memory.sh            # dry run — show the plan
    bash scripts/bind-project-memory.sh --apply    # perform it

That script is idempotent, backs up to ~/.claude/memory-backups/<stamp>/ before
touching anything, and ends with the verification gate the ingest preflight
depends on. See CLAUDE.md § Layout and § Ingest step 2.
EOF
exit 64  # EX_USAGE — fail loudly so a scripted caller doesn't sail past this
