#!/usr/bin/env bash
# delta-walk.sh — emit the ingest `Deltas walked:` line from the REAL find
# results, and list the delta files.
#
#   bash scripts/delta-walk.sh                    # uses wiki/.last-ingest
#   bash scripts/delta-walk.sh <iso-watermark>    # explicit cutoff
#   bash scripts/delta-walk.sh --list             # also print the file paths
#
# WHY THIS SCRIPT EXISTS
# CLAUDE.md makes the `Deltas walked:` line mandatory and states that a class
# *absent* from the line is the footprint of a silent skip. That made the
# detector share a failure mode with the thing it detects: it was 11 field
# names typed from memory every run. Here the field list comes from
# RAW_SUBPATHS, so a class can be reported as 0 but can never go missing.
set -euo pipefail
cd "$(dirname "$0")/.."   # vault root
# shellcheck source=raw-classes.sh
. "$(dirname "$0")/raw-classes.sh"

LIST=0
ARG=""
for a in "$@"; do
  case "$a" in
    --list) LIST=1 ;;
    *) ARG="$a" ;;
  esac
done

WATERMARK_FILE="wiki/.last-ingest"
if [ -n "$ARG" ]; then
  RAW_CUTOFF="$ARG"
elif [ -f "$WATERMARK_FILE" ]; then
  RAW_CUTOFF=$(tr -d '[:space:]' < "$WATERMARK_FILE")
else
  RAW_CUTOFF=""   # bootstrap: no watermark yet, walk everything
fi

# --- THE CUTOFF TRAP (both halves are load-bearing on BSD/macOS find) --------
#   s/Z$//  BSD find silently REJECTS the trailing Z and returns ZERO matches.
#   s/T/ /  With the T separator BSD find mis-parses and UNDER-filters, pulling
#           in already-ingested files. That one is the dangerous direction: it
#           returns too many, not zero, so it looks like legitimate work while
#           silently re-folding stale content into the wiki.
# Tested in tests/run.sh. Do not "simplify" this line.
if [ -n "$RAW_CUTOFF" ]; then
  CUTOFF=$(printf '%s' "$RAW_CUTOFF" | sed 's/Z$//; s/T/ /')
else
  CUTOFF=""
fi

present_dirs=""
missing_dirs=""
for d in $RAW_SUBPATHS; do
  if [ -d "$d" ]; then present_dirs="$present_dirs $d"; else missing_dirs="$missing_dirs $d"; fi
done

# README.md in a raw dir is kit documentation, not synced content. Counting it
# made every empty source report 1 and would have fed READMEs to ingest.
count_for() {
  local dir="$1"
  [ -d "$dir" ] || { echo 0; return; }
  if [ -n "$CUTOFF" ]; then
    find -L "$dir" -type f -name '*.md' ! -name 'README.md' -newermt "$CUTOFF" 2>/dev/null | wc -l | tr -d ' '
  else
    find -L "$dir" -type f -name '*.md' ! -name 'README.md' 2>/dev/null | wc -l | tr -d ' '
  fi
}

line="Deltas walked:"
sep=" "
for d in $RAW_SUBPATHS; do
  n=$(count_for "$d")
  case "$d" in
    projects|slack|gcal) label="$d/" ;;
    *)                   label="$d"  ;;
  esac
  line="${line}${sep}${label}=${n}"
  sep=", "
done
echo "$line"

# A missing directory is a real finding, never a silent zero.
if [ -n "$missing_dirs" ]; then
  echo "WARNING: source directories absent (reported as 0, but they should exist):$missing_dirs" >&2
fi

# A dangling projects/* symlink is skipped SILENTLY by `find -L`, so projects/=0
# can look normal when it is not. Surface it.
for l in projects/*; do
  if [ -L "$l" ] && [ ! -e "$l" ]; then
    echo "WARNING: dangling symlink $l -> $(readlink "$l") — find -L skips it silently; run scripts/refresh-project-symlinks.sh" >&2
  fi
done

if [ "$LIST" = 1 ]; then
  for d in $present_dirs; do
    if [ -n "$CUTOFF" ]; then
      find -L "$d" -type f -name '*.md' ! -name 'README.md' -newermt "$CUTOFF" 2>/dev/null || true
    else
      find -L "$d" -type f -name '*.md' ! -name 'README.md' 2>/dev/null || true
    fi
  done
fi
