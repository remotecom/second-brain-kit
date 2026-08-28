#!/usr/bin/env bash
# linkrot-lint.sh — audit vault link integrity.
# Detects: dangling projects/ symlinks, dead wiki->raw source links,
# dead wiki->wiki links, and malformed links. Read-only; prints a report.
# Run from the vault root: bash scripts/linkrot-lint.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # vault root

# Raw-layer definitions are shared with delta-walk.sh — see scripts/raw-classes.sh.
# shellcheck source=raw-classes.sh
. "$(dirname "$0")/raw-classes.sh"

# Link patterns, built once from $RAW_ALT.
PAT_RAW='\[\['"($RAW_ALT)"'/[^]|#]+'
PAT_RAW_ANN='\[\['"($RAW_ALT)"'/[^]|#]+\]\](_\(raw pruned[^)]*\)_)?'
PAT_RAW_MD='\[\['"($RAW_ALT)"'/[^]|#]+\.md\]\]'

# Per-run temp files. Fixed /tmp paths collided between a fixture-vault test
# run and a real run; mktemp keeps them independent.
TMP_DEAD_RAW=$(mktemp -t linkrot_raw)
TMP_DEAD_WIKI=$(mktemp -t linkrot_wiki)
trap 'rm -f "$TMP_DEAD_RAW" "$TMP_DEAD_WIKI"' EXIT

section() { printf '\n## %s\n\n' "$1"; }

echo "# Vault link-integrity report"
echo "_Generated $(date -u '+%Y-%m-%d %H:%M UTC') by scripts/linkrot-lint.sh (read-only)_"

section "1. Dangling projects/ symlinks"
for l in projects/*; do
  [ -L "$l" ] || continue
  if [ -e "$l" ]; then :; else echo "- BROKEN  $l -> $(readlink "$l")"; fi
done

section "1b. Live project memory dirs with NO vault symlink (unlinked -> never ingested)"
CLAUDE_PROJECTS="$HOME/.claude/projects"
ENC=$(printf '%s' "$HOME/cursor" | sed 's#[^A-Za-z0-9]#-#g')   # non-alnum -> '-' (matches Claude Code cwd encoding)
# set of targets already covered by a vault symlink (one per line)
linked_targets=$(for l in projects/*; do [ -L "$l" ] && readlink "$l"; done; true)   # `; true`: loop ends on a failed -L test; set -e would abort
found_unlinked=0
for memdir in "$CLAUDE_PROJECTS/${ENC}"-*/memory; do
  [ -d "$memdir" ] || continue
  [ "$(find "$memdir" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')" -gt 0 ] || continue
  if ! printf '%s\n' "$linked_targets" | grep -qxF "$memdir"; then
    found_unlinked=1
    echo "- UNLINKED $memdir ($(find "$memdir" -maxdepth 1 -name '*.md'|wc -l|tr -d ' ') memories) — add via refresh-project-symlinks.sh, then ingest"
  fi
done
if [ "$found_unlinked" = 0 ]; then echo "(none — every live project memory dir is symlinked)"; fi


# NOTE: log.md is append-only history/prose that legitimately quotes [[...]]
# link syntax as text; it is excluded from all link scans below.
WIKI() { find wiki -name '*.md' ! -name 'log.md' -print0; }

# Every grep below may legitimately match nothing (an empty or young vault).
# grep exits 1 on no-match, and `set -o pipefail` propagates that through the
# pipeline — which is what made this script abort mid-report. `|| true` on each
# scanning grep is deliberate, not sloppy.

section "2. Dead wiki -> raw source links"
WIKI | xargs -0 grep -hoE "$PAT_RAW" 2>/dev/null \
  | sed 's/^\[\[//' | sort -u \
  | while read -r t; do [ -e "$t.md" ] || echo "$t"; done > "$TMP_DEAD_RAW" || true
# actionable = dead occurrences NOT annotated with the (raw pruned) marker
actionable=$(WIKI | xargs -0 grep -hoE "$PAT_RAW_ANN" 2>/dev/null \
  | while read -r m; do t=$(printf '%s' "$m" | sed -E 's/^\[\[//; s/\]\].*//');
      if [ ! -e "$t.md" ] && ! printf '%s' "$m" | grep -q '_(raw pruned'; then echo x; fi; done \
  | wc -l | tr -d ' ' || true)
echo "Distinct dead-target raw links: $(wc -l < "$TMP_DEAD_RAW" | tr -d ' ')  (most are ACCEPTED — annotated \`_(raw pruned)_\`, source purged/consolidated)"
echo "ACTIONABLE (dead + UNannotated) occurrences: ${actionable:-0}"
echo '```'
echo "dead targets by class:"; sed -E 's#/.*##' "$TMP_DEAD_RAW" | sort | uniq -c
echo '```'

section "3. Dead wiki -> wiki links (target|referencing-pages)"
WIKI | xargs -0 grep -hoE '\[\[wiki/[^]|#]+' 2>/dev/null | sed 's/^\[\[//' | sort -u \
  | while read -r t; do [ -f "$t.md" ] || echo "$t"; done > "$TMP_DEAD_WIKI" || true
echo "Total dead wiki->wiki links: $(wc -l < "$TMP_DEAD_WIKI" | tr -d ' ')  (expected: only the <name> template placeholder)"
echo '```'
while read -r t; do
  refs=$(grep -rl "\[\[$t" wiki --include='*.md' ! -name 'log.md' 2>/dev/null | sed 's#wiki/##;s#\.md$##' | paste -sd', ' - || true)
  printf '%-55s <- %s\n' "$t" "$refs"
done < "$TMP_DEAD_WIKI"
echo '```'

section "4. Malformed links"
echo '```'
# NOTE: this check is deliberately projects/-specific, not RAW_CLASSES-driven.
# It catches links that embed the full encoded ~/.claude/projects path, which is
# a failure mode unique to the projects/ symlink layer.
echo "full-encoded-path links (embed ~/.claude path):"
WIKI | xargs -0 grep -hoE '\[\[projects/-Users-[^]|#]+' 2>/dev/null | sort | uniq -c || true
echo ".md-suffixed raw links (break to .md.md):"
WIKI | xargs -0 grep -hoE "$PAT_RAW_MD" 2>/dev/null | grep -v '_(raw pruned' | sort -u || true
echo '```'

section "5. RAW PURITY violations — [[wiki/...]] backlinks inside raw files"
# shellcheck disable=SC2086 — $RAW_DIRS must word-split into separate dir args.
viol=$(grep -rlE '\[\[wiki/' $RAW_DIRS 2>/dev/null | wc -l | tr -d ' ' || true)
echo "raw files containing [[wiki/...]] backlinks (should be 0): ${viol:-0}"
if [ "${viol:-0}" != 0 ]; then
  echo '```'
  grep -rlE '\[\[wiki/' $RAW_DIRS 2>/dev/null | sort | head -40 || true
  echo "(these are sync/agent overreach — raw must not carry wiki synthesis; the next sync of that class should overwrite in-window files)"
  echo '```'
fi
