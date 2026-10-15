#!/usr/bin/env bash
# bind-project-memory.sh — make the VAULT the canonical home for Claude Code
# project memory, so every runtime (Claude Code, Cowork, anything else pointed
# at the vault dir) sees the raw layer as real files under the vault root.
#
#   bash scripts/bind-project-memory.sh            # dry run — show plan only
#   bash scripts/bind-project-memory.sh --apply    # perform it
#
# WHY (the Cowork problem):
#   Historically projects/<slug> was a SYMLINK pointing OUT of the vault at
#   ~/.claude/projects/<encoded-cwd>/memory. Claude Code running locally can
#   follow that. Claude Cowork — and any sandbox scoped to the selected
#   directory — cannot traverse past the vault root, so `find -L projects`
#   returns 0 and ingest silently reports projects/=0. Same failure mode as the
#   an unbound repo, but permanent and invisible.
#
# THE FIX — invert the link direction:
#   BEFORE  vault/projects/obsidian  --symlink-->  ~/.claude/.../memory  [real]
#   AFTER   vault/projects/obsidian  [real]  <--symlink--  ~/.claude/.../memory
#
#   Claude Code keeps writing to the same ~/.claude path (the OS resolves the
#   symlink), so auto-memory is unaffected. But the bytes now live inside the
#   vault, where every runtime can reach them. Bonus: memory survives Claude
#   Code transcript-dir cleanup, which is what ate memories before the
#   cleanupPeriodDays setting.
#
# IDEMPOTENT. Re-run it any time — before an ingest, after opening a repo from a
# new working dir, or after a Claude Code upgrade recreates a memory dir.
set -euo pipefail
# The vault is --vault <dir>, else $SECOND_BRAIN_VAULT, else the current
# directory. These scripts live in the kit, not in the vault, so they never
# assume where they sit relative to it.
HERE=$(cd "$(dirname "$0")" && pwd)
VAULT="${SECOND_BRAIN_VAULT:-}"
_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --vault) VAULT="${2:-}"; shift 2 ;;
    --vault=*) VAULT="${1#*=}"; shift ;;
    *) _args+=("$1"); shift ;;
  esac
done
set -- ${_args[@]+"${_args[@]}"}
[ -n "$VAULT" ] || VAULT=$(pwd)
cd "$VAULT" 2>/dev/null || { echo "ERROR: vault $VAULT does not exist." >&2; exit 2; }
VAULT=$(pwd)
[ -d wiki ] || { echo "ERROR: $VAULT is not a vault (no wiki/). Pass --vault <dir>." >&2; exit 2; }
APPLY=""
[ "${1:-}" = "--apply" ] && APPLY=1

CLAUDE_PROJECTS="$HOME/.claude/projects"
BACKUP_ROOT="$HOME/.claude/memory-backups"
# Claude Code keeps each repo's memory in ~/.claude/projects/<encoded cwd>/memory,
# where the encoding turns every non-alphanumeric char into '-'. Repos are
# looked for under --repos-root <dir> / $SECOND_BRAIN_REPOS_ROOT, by default the
# folder that holds the vault; the slug is the repo path below that root.
REPOS_ROOT="${SECOND_BRAIN_REPOS_ROOT:-$(dirname "$VAULT")}"
ENC=$(printf '%s' "$REPOS_ROOT" | sed 's#[^A-Za-z0-9]#-#g')
STAMP=$(date -u '+%Y%m%dT%H%M%SZ')

echo "# bind-project-memory — $(date -u '+%Y-%m-%d %H:%M UTC')"
[ -z "$APPLY" ] && echo "# DRY RUN — nothing will change. Re-run with --apply." || true
echo "# canonical store: $VAULT/projects/<slug>   (real dirs)"
echo "# bound from:      $CLAUDE_PROJECTS/${ENC}-<slug>/memory   (symlinks)"
echo ""

md_count() { find "$1" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' '; }
backup() {  # backup <path> <slug>
  [ -z "$APPLY" ] && return 0
  mkdir -p "$BACKUP_ROOT/$STAMP"
  cp -a "$1" "$BACKUP_ROOT/$STAMP/$2"
}

# ---------------------------------------------------------------------------
# Pass 1 — every live memory dir under ~/.claude/projects for a repo under REPOS_ROOT
# ---------------------------------------------------------------------------
echo "## Binding live memory dirs"
shopt -s nullglob
for memdir in "$CLAUDE_PROJECTS/${ENC}"-*/memory; do
  encdir=$(basename "$(dirname "$memdir")")
  slug=${encdir#"${ENC}"-}
  target="$VAULT/projects/$slug"
  # cowork/ and sessions/ are the vault's own stores (capture, saved sessions).
  # A repo with one of those names must not be merged into them.
  case "$slug" in cowork|sessions) echo "  skip     $slug  (a repo with a reserved name; its memories stay in ~/.claude)"; continue ;; esac

  # --- already correct: memory is a symlink pointing at the vault ---
  if [ -L "$memdir" ] && [ "$(readlink "$memdir")" = "$target" ] && [ -d "$target" ] && [ ! -L "$target" ]; then
    echo "  ok       $slug  ($(md_count "$target") memories, canonical in vault)"
    continue
  fi

  # --- legacy layout: vault entry is a symlink out to a real memory dir ---
  if [ -L "$target" ] && [ ! -L "$memdir" ] && [ -d "$memdir" ]; then
    n=$(md_count "$memdir")
    echo "  MIGRATE  $slug  ($n memories) — inverting symlink direction"
    if [ -n "$APPLY" ]; then
      backup "$memdir" "$slug"
      rm "$target"
      mv "$memdir" "$target"
      ln -sfn "$target" "$memdir"
      echo "           -> vault realdir $(md_count "$target"), readable via link $(md_count "$memdir")"
    fi
    continue
  fi

  # --- Claude Code recreated a real memory dir alongside the vault store ---
  if [ -d "$memdir" ] && [ ! -L "$memdir" ] && [ -d "$target" ] && [ ! -L "$target" ]; then
    n=$(md_count "$memdir")
    echo "  MERGE    $slug  ($n memories in a recreated ~/.claude dir) — newer wins"
    if [ -n "$APPLY" ]; then
      backup "$memdir" "$slug-recreated"
      # -u: only copy when source is newer than dest (or dest absent)
      cp -pu "$memdir"/*.md "$target"/ 2>/dev/null || true
      rm -rf "$memdir"
      ln -sfn "$target" "$memdir"
      echo "           -> merged; vault now $(md_count "$target") memories"
    fi
    continue
  fi

  # --- new repo, memory only in ~/.claude, nothing in the vault yet ---
  if [ -d "$memdir" ] && [ ! -L "$memdir" ] && [ ! -e "$target" ]; then
    n=$(md_count "$memdir")
    [ "$n" -eq 0 ] && { echo "  skip     $slug  (no memories yet)"; continue; }
    echo "  ADOPT    $slug  ($n memories) — new project, moving into vault"
    if [ -n "$APPLY" ]; then
      backup "$memdir" "$slug"
      mv "$memdir" "$target"
      ln -sfn "$target" "$memdir"
      echo "           -> vault realdir $(md_count "$target")"
    fi
    continue
  fi

  echo "  ?        $slug  — unexpected layout, inspect by hand:"
  echo "             memdir: $(ls -ld "$memdir" 2>/dev/null || echo absent)"
  echo "             target: $(ls -ld "$target" 2>/dev/null || echo absent)"
done

# ---------------------------------------------------------------------------
# Pass 2 — vault stores with no ~/.claude binding (repo not opened yet, or
# Claude Code removed the transcript dir). Re-establish the symlink so the next
# session's auto-memory lands in the vault instead of a fresh detached dir.
# ---------------------------------------------------------------------------
echo ""
echo "## Re-binding vault stores back into ~/.claude"
for target in "$VAULT"/projects/*; do
  [ -d "$target" ] || continue
  [ -L "$target" ] && continue          # legacy symlink, handled in pass 1
  slug=$(basename "$target")
  # projects/cowork is not a repo — it's the `capture` op's store for runtimes
  # with no auto-memory. It must never get a ~/.claude binding.
  [ "$slug" = "cowork" ] && { echo "  skip     cowork (capture store, intentionally unbound)"; continue; }
  # projects/sessions holds sessions saved from the app (Save & close). Not a repo.
  [ "$slug" = "sessions" ] && { echo "  skip     sessions (saved sessions, intentionally unbound)"; continue; }
  encdir="$CLAUDE_PROJECTS/${ENC}-$slug"
  memdir="$encdir/memory"
  if [ -L "$memdir" ] && [ "$(readlink "$memdir")" = "$target" ]; then
    continue                            # already reported ok in pass 1
  fi
  if [ -e "$memdir" ] && [ ! -L "$memdir" ]; then
    continue                            # real dir — pass 1 owns this case
  fi
  echo "  BIND     $slug -> $memdir"
  if [ -n "$APPLY" ]; then
    mkdir -p "$encdir"
    ln -sfn "$target" "$memdir"
  fi
done

# ---------------------------------------------------------------------------
# Pass 3 — verification. This is the gate the ingest preflight relies on.
# ---------------------------------------------------------------------------
echo ""
echo "## Verification"
fail=0
for target in "$VAULT"/projects/*; do
  slug=$(basename "$target")
  if [ -L "$target" ]; then
    echo "  FAIL     projects/$slug is still a SYMLINK -> $(readlink "$target")"
    echo "           Cowork cannot follow this. Re-run with --apply."
    fail=1
  elif [ -d "$target" ]; then
    echo "  ok       projects/$slug  real dir, $(md_count "$target") memories"
  fi
done
reachable=$(find -L projects -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
echo ""
echo "  raw memories reachable from vault root: $reachable"
[ "$reachable" -eq 0 ] && { echo "  FAIL: zero — ingest would silently report projects/=0"; fail=1; }
[ -d "$BACKUP_ROOT/$STAMP" ] && echo "  backup: $BACKUP_ROOT/$STAMP"

echo ""
if [ "$fail" -ne 0 ]; then
  echo "STATUS: needs attention (see FAIL above)"
  exit 1
fi
[ -z "$APPLY" ] && echo "STATUS: dry run clean — re-run with --apply to perform any MIGRATE/ADOPT/MERGE/BIND above" \
                || echo "STATUS: bound. Run 'bash scripts/linkrot-lint.sh' for the full link report."
