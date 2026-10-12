#!/usr/bin/env bash
# delta-walk.sh — emit the ingest `Deltas walked:` line from the REAL find
# results, and list the delta files.
#
#   bash scripts/delta-walk.sh                    # uses wiki/.last-ingest
#   bash scripts/delta-walk.sh --vault <dir> <iso>       # explicit cutoff
#   bash scripts/delta-walk.sh --vault <dir> --list      # also print the file paths
#
# WHY THIS SCRIPT EXISTS
# CLAUDE.md makes the `Deltas walked:` line mandatory and states that a class
# *absent* from the line is the footprint of a silent skip. That made the
# detector share a failure mode with the thing it detects: it was 11 field
# names typed from memory every run. Here the field list comes from
# RAW_SUBPATHS, so a class can be reported as 0 but can never go missing.
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
# shellcheck source=raw-classes.sh
. "$HERE/raw-classes.sh"

# --- VERSION-SKEW GUARD (must sit before the first use of any RAW_* var) -----
# A NEW delta-walk.sh beside a STALE raw-classes.sh is a real configuration
# (scripts get copied piecemeal), not a hypothetical. Under `set -u` that skew
# aborts mid-script; and because the whole `Deltas walked:` line is assembled
# in a loop before a single echo, the abort prints NOTHING. So: default what is
# optional, hard-fail what is required, and say WHICH file is stale.
: "${RAW_UNIMPLEMENTED:=}"
for _req in RAW_SUBPATHS RAW_CLASSES; do
  eval "_v=\${$_req:-}"
  if [ -z "$_v" ]; then
    echo "ERROR: scripts/raw-classes.sh did not define $_req — it is stale or missing." >&2
    echo "       delta-walk.sh and raw-classes.sh must be updated together." >&2
    exit 1
  fi
done

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

# --- THE CUTOFF TRAPS -------------------------------------------------------
# The watermark is stored as ISO-8601 **UTC** (`2026-08-19T22:04:11Z`). Handing
# that to `find -newermt` has three independent traps, two of which fail
# silently:
#
#   1. The trailing `Z`. BSD find cannot parse it — it exits 1 with
#      "Can't parse date/time". Called the way ingest calls it
#      (`2>/dev/null | wc -l`) the error vanishes and you get a silent ZERO.
#   2. The `T` separator. Cheap defence for other BSD variants; measured to be
#      harmless on macOS 15.6.1 (with Z stripped, the T form and the space form
#      match identically). The older claim that `T` makes find UNDER-filter and
#      return "too many" does NOT reproduce — do not restore that folklore.
#   3. THE ZONE TRAP (the one that actually cost us files). Once stripped to
#      `2026-08-19 22:04:11`, find parses it as **LOCAL time, not UTC**. In PDT
#      (UTC-7) that puts the cutoff 7 hours LATER than the watermark means,
#      opening a silent blind window at the head of every ingest. It does not
#      return zero (obvious) and does not over-return (looks like work) — it
#      quietly UNDER-filters and drops raw written just after the previous run.
#      Confirmed cost: 2026-08-04 (1 file) and 2026-08-19 (5 files).
#
# So: convert UTC -> local BEFORE handing the string to find. The bare
# `sed 's/Z$//; s/T/ /'` form is NOT sufficient and must not be used as the
# cutoff. `--compare-naive` prints what that buggy form would have matched, so
# the blind window can be measured rather than assumed.
to_local_cutoff() {
  python3 -c "
import datetime,sys
v=sys.argv[1].split('.')[0].rstrip('Z')
d=datetime.datetime.strptime(v,'%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc)
print(d.astimezone().strftime('%Y-%m-%d %H:%M:%S'))
" "$1"
}

if [ -n "$RAW_CUTOFF" ]; then
  CUTOFF=$(to_local_cutoff "$RAW_CUTOFF")
  NAIVE=$(printf '%s' "$RAW_CUTOFF" | sed 's/Z$//; s/T/ /')
else
  CUTOFF=""
  NAIVE=""
fi

present_dirs=""
missing_dirs=""
for d in $RAW_SUBPATHS; do
  if [ -d "$d" ]; then present_dirs="$present_dirs $d"; else missing_dirs="$missing_dirs $d"; fi
done

# README.md in a raw dir is vault documentation, not synced content. Counting it
# made every empty source report 1 and would have fed READMEs to ingest.
count_for() {
  local dir="$1" cut="$2"
  [ -d "$dir" ] || { echo 0; return; }
  if [ -n "$cut" ]; then
    find -L "$dir" -type f -name '*.md' ! -name 'README.md' -newermt "$cut" 2>/dev/null | wc -l | tr -d ' '
  else
    find -L "$dir" -type f -name '*.md' ! -name 'README.md' 2>/dev/null | wc -l | tr -d ' '
  fi
}

is_unimplemented() {
  case " $RAW_UNIMPLEMENTED " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

echo "Cutoff: watermark ${RAW_CUTOFF:-<bootstrap: none>} (UTC) -> ${CUTOFF:-<all files>} (local, what find gets)"

line="Deltas walked:"
sep=" "
for d in $RAW_SUBPATHS; do
  case "$d" in
    projects|slack|gcal) label="$d/" ;;
    *)                   label="$d"  ;;
  esac
  if is_unimplemented "$d"; then
    n=$(count_for "$d" "$CUTOFF")
    if [ "$n" = 0 ]; then
      line="${line}${sep}${label}=SKIPPED-not-implemented"
    else
      # Files appeared in a class with no sync op — that is a real finding.
      line="${line}${sep}${label}=${n}"
    fi
  else
    line="${line}${sep}$(printf '%s=%s' "$label" "$(count_for "$d" "$CUTOFF")")"
  fi
  sep=", "
done
echo "$line"

# Measure the zone-trap blind window instead of trusting that it is closed.
if [ -n "$CUTOFF" ] && [ -n "$NAIVE" ]; then
  tot_ok=0; tot_naive=0
  for d in $RAW_SUBPATHS; do
    tot_ok=$(( tot_ok + $(count_for "$d" "$CUTOFF") ))
    tot_naive=$(( tot_naive + $(count_for "$d" "$NAIVE") ))
  done
  blind=$(( tot_ok - tot_naive ))
  echo "Zone check: zone-corrected=$tot_ok, naive-sed=$tot_naive, blind window closed by this fix=$blind file(s)"
  [ "$blind" -lt 0 ] && echo "WARNING: naive cutoff matched MORE than the corrected one — re-derive before ingesting." >&2
fi

# A missing directory is a real finding, never a silent zero.
if [ -n "$missing_dirs" ]; then
  echo "WARNING: source directories absent (reported as 0, but they should exist):$missing_dirs" >&2
fi

# Raw-layer reachability. Since the 2026-08-03 inversion, projects/* must be
# REAL DIRS inside the vault; a symlink pointing out to ~/.claude is invisible
# to any dir-scoped runtime (Cowork) and ingests as a silent 0.
for l in projects/*; do
  [ -e "$l" ] || [ -L "$l" ] || continue
  if [ -L "$l" ]; then
    echo "WARNING: $l is a SYMLINK -> $(readlink "$l"); points out of the vault and is invisible to dir-scoped runtimes. Fix: bash scripts/bind-project-memory.sh --apply" >&2
  fi
done
reach=$(find -L projects -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
echo "Raw memories reachable from vault root: $reach (0 means ingest would silently skip projects/)"
[ "$reach" = 0 ] && echo "WARNING: projects/ is unreachable — STOP and run bind-project-memory.sh --apply before ingesting." >&2

if [ "$LIST" = 1 ]; then
  echo "--- delta files ---"
  for d in $present_dirs; do
    if [ -n "$CUTOFF" ]; then
      find -L "$d" -type f -name '*.md' ! -name 'README.md' -newermt "$CUTOFF" 2>/dev/null || true
    else
      find -L "$d" -type f -name '*.md' ! -name 'README.md' 2>/dev/null || true
    fi
  done
fi
