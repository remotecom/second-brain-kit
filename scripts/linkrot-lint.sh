#!/usr/bin/env bash
# linkrot-lint.sh — audit vault link integrity.
# Detects: dangling projects/ symlinks, dead wiki->raw source links,
# dead wiki->wiki links, and malformed links. Read-only; prints a report.
# Run from the vault root: bash scripts/linkrot-lint.sh
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

# Raw-layer definitions are shared with delta-walk.sh — see scripts/raw-classes.sh.
# The class list used to be hand-copied into 5 places in this file and had already
# drifted (two sites listed the classes in a different order). One source now.
# shellcheck source=raw-classes.sh
. "$HERE/raw-classes.sh"

# Link patterns, built once from $RAW_ALT so gdrive/gmail/gcal are covered
# automatically the moment they are added to raw-classes.sh.
PAT_RAW='\[\['"($RAW_ALT)"'/[^]|#]+'
PAT_RAW_ANN='\[\['"($RAW_ALT)"'/[^]|#]+\]\](_\(raw pruned[^)]*\)_)?'
PAT_RAW_MD='\[\['"($RAW_ALT)"'/[^]|#]+\.md\]\]'

# Per-run temp files. Fixed /tmp paths collide between concurrent runs.
TMP_DEAD_RAW=$(mktemp -t linkrot_raw)
TMP_DEAD_WIKI=$(mktemp -t linkrot_wiki)
trap 'rm -f "$TMP_DEAD_RAW" "$TMP_DEAD_WIKI"' EXIT

section() { printf '\n## %s\n\n' "$1"; }

echo "# Vault link-integrity report"
echo "_Generated $(date -u '+%Y-%m-%d %H:%M UTC') by scripts/linkrot-lint.sh (read-only)_"

# Sections 1 / 1b were rewritten 2026-08-03 when the project-memory link
# direction was inverted (vault = canonical real dirs, ~/.claude = symlinks in).
# The old checks assumed the opposite and would report every project as
# "UNLINKED" under the new layout. See the vault CLAUDE.md, Layout.
section "1. Raw-layer reachability (projects/ must be real dirs in the vault)"
found_unreachable=0
for l in projects/*; do
  [ -e "$l" ] || [ -L "$l" ] || continue
  slug=$(basename "$l")
  if [ -L "$l" ]; then
    found_unreachable=1
    echo "- SYMLINK  projects/$slug -> $(readlink "$l")"
    echo "           Points out of the vault; invisible to dir-scoped runtimes (Cowork)."
    echo "           Fix: bash scripts/bind-project-memory.sh --apply"
  elif [ ! -d "$l" ]; then
    found_unreachable=1
    echo "- NOTADIR  projects/$slug is a file, expected a directory"
  fi
done
[ "$found_unreachable" = 0 ] && echo "(none — every projects/* entry is a real dir inside the vault)"
echo ""
echo "- reachable raw memories: $(find -L projects -name '*.md' 2>/dev/null | wc -l | tr -d ' ') (0 means ingest would silently skip projects/)"

section "1b. Live memory dirs not bound to the vault (unbound -> never ingested)"
CLAUDE_PROJECTS="$HOME/.claude/projects"
# Claude Code keeps each repo's memory in ~/.claude/projects/<encoded cwd>/memory,
# where the encoding turns every non-alphanumeric char into '-'. Repos are
# looked for under --repos-root <dir> / $SECOND_BRAIN_REPOS_ROOT, by default the
# folder that holds the vault; the slug is the repo path below that root.
REPOS_ROOT="${SECOND_BRAIN_REPOS_ROOT:-$(dirname "$VAULT")}"
ENC=$(printf '%s' "$REPOS_ROOT" | sed 's#[^A-Za-z0-9]#-#g')
found_unbound=0
shopt -s nullglob
for memdir in "$CLAUDE_PROJECTS/${ENC}"-*/memory; do
  slug=$(basename "$(dirname "$memdir")"); slug=${slug#"${ENC}"-}
  # Correct state: memdir is a symlink pointing INTO the vault.
  if [ -L "$memdir" ]; then
    tgt=$(readlink "$memdir")
    case "$tgt" in
      "$VAULT"/projects/*) continue ;;
      *) found_unbound=1
         echo "- MISBOUND $slug: ~/.claude memory -> $tgt (outside the vault)" ;;
    esac
  elif [ -d "$memdir" ]; then
    n=$(find "$memdir" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
    [ "$n" -gt 0 ] || continue
    found_unbound=1
    echo "- UNBOUND  $slug: real dir in ~/.claude with $n memories, not bound to the vault"
  fi
done
[ "$found_unbound" = 0 ] && echo "(none — every live memory dir is bound into the vault)" \
                         || echo "  Fix: bash scripts/bind-project-memory.sh --apply, then ingest the adopted files as a bootstrap"

# NOTE: log.md is append-only history/prose that legitimately quotes [[...]]
# link syntax as text; it is excluded from all link scans below.
WIKI() { find wiki -name '*.md' ! -name 'log.md' -print0; }

section "2. Dead wiki -> raw source links"
{ WIKI | xargs -0 grep -hoE "$PAT_RAW" || true; } \
  | sed 's/^\[\[//' | sort -u | while read -r t; do [ -e "$t.md" ] || echo "$t"; done > "$TMP_DEAD_RAW"
# actionable = dead occurrences NOT annotated with the (raw pruned) marker
actionable=$({ WIKI | xargs -0 grep -hoE "$PAT_RAW_ANN" || true; } \
  | while read -r m; do t=$(printf '%s' "$m" | sed -E 's/^\[\[//; s/\]\].*//');
      if [ ! -e "$t.md" ] && ! printf '%s' "$m" | grep -q '_(raw pruned'; then echo x; fi; done | wc -l | tr -d ' ')
echo "Distinct dead-target raw links: $(wc -l < "$TMP_DEAD_RAW" | tr -d ' ')  (most are ACCEPTED — annotated \`_(raw pruned)_\`, source purged/consolidated)"
echo "ACTIONABLE (dead + UNannotated) occurrences: $actionable"
echo '```'
echo "dead targets by class:"; sed -E 's#/.*##' "$TMP_DEAD_RAW" | sort | uniq -c
echo '```'

section "3. Dead wiki -> wiki links (target|referencing-pages)"
{ WIKI | xargs -0 grep -hoE '\[\[wiki/[^]|#]+' || true; } | sed 's/^\[\[//' | sort -u \
  | while read -r t; do [ -f "$t.md" ] || echo "$t"; done > "$TMP_DEAD_WIKI"
echo "Total dead wiki->wiki links: $(wc -l < "$TMP_DEAD_WIKI" | tr -d ' ')  (expected: only the <name> template placeholder)"
echo '```'
while read -r t; do
  refs=$({ grep -rl "\[\[$t" wiki --include='*.md' --exclude='log.md' || true; } | sed 's#wiki/##;s#\.md$##' | paste -sd', ' -)
  printf '%-55s <- %s\n' "$t" "$refs"
done < "$TMP_DEAD_WIKI"
echo '```'

section "4. Malformed links"
echo '```'
echo "full-encoded-path links (embed ~/.claude path):"
{ WIKI | xargs -0 grep -hoE '\[\[projects/-Users-[^]|#]+' || true; } | sort | uniq -c
echo ".md-suffixed raw links (break to .md.md):"
{ WIKI | xargs -0 grep -hoE "$PAT_RAW_MD" || true; } | { grep -v '_(raw pruned' || true; } | sort -u
echo '```'

section "5. RAW PURITY violations — [[wiki/...]] backlinks inside raw files"
# Scope is linear/ notion/ slack/ gdrive/ gcal/ gmail/. projects/ is deliberately EXCLUDED: the memory schema
# and the `capture` op both sanction linking wiki pages from a memory body ("link related
# memories with [[their-name]] and wiki pages with [[wiki/...]]"), and CLAUDE.md scopes the
# raw-purity rule to "a linear/* or notion/* file". Including projects/ produced permanent
# false positives (4 as of 2026-08-04).
viol=$({ grep -rlE '\[\[wiki/' linear notion slack gdrive gcal gmail 2>/dev/null || true; } | wc -l | tr -d ' ')
echo "raw files containing [[wiki/...]] backlinks (should be 0): $viol"
if [ "$viol" != 0 ]; then
  echo '```'
  grep -rlE '\[\[wiki/' linear notion slack gdrive gcal gmail 2>/dev/null | sort | head -40
  echo "(these are sync/agent overreach — raw must not carry wiki synthesis; the next sync of that class should overwrite in-window files)"
  echo '```'
fi

section "6. RAW ANNOTATION violations — model-authored prose inside raw files"
# Added 2026-08-28 after a sync agent wrote 75 `_(...)_` glosses into slack/ and,
# worse, replaced a 35-reply thread and several message bodies with one-line
# summaries. The vault Rules forbid editorial compression by a sync agent
# ("a hand-edit by another name"), but nothing detected it — the mtime
# verification gate passes happily on a file full of invented prose.
#
# Heuristic, deliberately narrow to stay low-noise:
#   a) `_(...)_` italic parentheticals — the shape the annotations took.
#   b) cross-references that stand in for content ("see Mentions", "captured above").
#   c) reply-count-in-place-of-replies ("35-reply thread", "N more replies").
# Slack message text can legitimately contain parentheses, so (a) matches only
# the italic-underscore form, which is authoring syntax rather than chat text.
RAWSCAN="slack linear notion gdrive gcal"
ann=0
for cls in $RAWSCAN; do
  [ -d "$cls" ] || continue
  n=$({ grep -rlE '_\([^)]{8,}\)_' "$cls" --include='*.md' || true; } | wc -l | tr -d ' ')
  x=$({ grep -rlE '\((see|captured|full thread) (Sent|Mentions|above|below)|[0-9]+-reply thread|[0-9]+\+? (more|further|remaining) (replies|messages)' "$cls" --include='*.md' || true; } | wc -l | tr -d ' ')
  ann=$((ann + n + x))
  printf '  %-10s italic-parenthetical files: %-5s cross-ref/count-substitute files: %s\n' "$cls/" "$n" "$x"
done
echo ""
echo "total raw files carrying suspected annotations: $ann  (target: 0 for any file written after 2026-08-28)"
if [ "$ann" != 0 ]; then
  echo '```'
  echo "sample offenders (first 15):"
  for cls in $RAWSCAN; do
    [ -d "$cls" ] || continue
    { grep -rlE '_\([^)]{8,}\)_' "$cls" --include='*.md' || true; }
  done | sort -u | head -15
  echo "NOTE: files predating 2026-08-28 may carry legacy annotations; the rule binds on re-sync."
  echo "A file inside a rolling window should be re-synced clean, not hand-edited."
  echo '```'
fi
