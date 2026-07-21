#!/usr/bin/env bash
# refresh-project-symlinks.sh — keep projects/* symlinks aligned with live
# Claude Code memory dirs. Run from the vault root BEFORE each ingest.
#
#   bash docs/audits/refresh-project-symlinks.sh        # create missing, report dangling (default)
#   bash docs/audits/refresh-project-symlinks.sh --prune # ALSO remove dangling symlinks (destructive)
#
# Rationale: memory lives inside ephemeral transcript dirs
# (~/.claude/projects/<encoded-cwd>/memory). When a repo is opened from a new
# working dir the encoded name changes, so new memories land unwatched and old
# symlinks dangle silently. This re-aligns them. See
# reference-memory-retention-and-vault-symlinks memory + the linkrot audit.
set -euo pipefail
cd "$(dirname "$0")/../.."   # vault root
PRUNE=${1:-}

CLAUDE_PROJECTS="$HOME/.claude/projects"
# encoded prefix for repos under ~/cursor. Claude Code encodes the cwd by
# replacing every non-alphanumeric char (/, ., etc.) with '-'.
ENC=$(printf '%s' "$HOME/cursor" | sed 's#[^A-Za-z0-9]#-#g')

echo "# project-symlink refresh — $(date -u '+%Y-%m-%d %H:%M UTC')"

echo ""
echo "## Live memory dirs -> vault symlink"
for memdir in "$CLAUDE_PROJECTS/${ENC}"-*/memory; do
  [ -d "$memdir" ] || continue
  [ "$(find "$memdir" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')" -gt 0 ] || continue
  encdir=$(basename "$(dirname "$memdir")")     # -Users-...-cursor-<friendly>
  friendly=${encdir#${ENC}-}                     # <friendly>
  link="projects/$friendly"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$memdir" ]; then
    echo "  ok      $link"
  elif [ -e "$link" ] || [ -L "$link" ]; then
    echo "  RELINK  $link  (was -> $(readlink "$link" 2>/dev/null))"
    ln -sfn "$memdir" "$link"
  else
    echo "  ADDED   $link -> $memdir  ($(find "$memdir" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ') memories)"
    ln -sfn "$memdir" "$link"
  fi
done

echo ""
echo "## Dangling vault symlinks (target gone — memories purged or repo path changed)"
found_dangle=0
for l in projects/*; do
  [ -L "$l" ] || continue
  if [ ! -e "$l" ]; then
    found_dangle=1
    if [ "$PRUNE" = "--prune" ]; then
      rm "$l"; echo "  PRUNED  $l"
    else
      echo "  DANGLING $l -> $(readlink "$l")   (rerun with --prune to remove)"
    fi
  fi
done
[ "$found_dangle" = 0 ] && echo "  (none)"

echo ""
echo "Done. Run 'bash docs/audits/linkrot-lint.sh' for the full link-integrity report."
