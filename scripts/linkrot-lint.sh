#!/usr/bin/env bash
# linkrot-lint.sh — audit vault link integrity.
# Detects: dangling projects/ symlinks, dead wiki->raw source links,
# dead wiki->wiki links, and malformed links. Read-only; prints a report.
# Run from the vault root: bash docs/audits/linkrot-lint.sh
set -euo pipefail
cd "$(dirname "$0")/../.."   # vault root

section() { printf '\n## %s\n\n' "$1"; }

echo "# Vault link-integrity report"
echo "_Generated $(date -u '+%Y-%m-%d %H:%M UTC') by docs/audits/linkrot-lint.sh (read-only)_"

section "1. Dangling projects/ symlinks"
for l in projects/*; do
  [ -L "$l" ] || continue
  if [ -e "$l" ]; then :; else echo "- BROKEN  $l -> $(readlink "$l")"; fi
done

section "1b. Live project memory dirs with NO vault symlink (unlinked -> never ingested)"
CLAUDE_PROJECTS="$HOME/.claude/projects"
ENC=$(printf '%s' "$HOME/cursor" | sed 's#[^A-Za-z0-9]#-#g')   # non-alnum -> '-' (matches Claude Code cwd encoding)
# set of targets already covered by a vault symlink (one per line)
linked_targets=$(for l in projects/*; do [ -L "$l" ] && readlink "$l"; done)
found_unlinked=0
for memdir in "$CLAUDE_PROJECTS/${ENC}"-*/memory; do
  [ -d "$memdir" ] || continue
  [ "$(find "$memdir" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')" -gt 0 ] || continue
  if ! printf '%s\n' "$linked_targets" | grep -qxF "$memdir"; then
    found_unlinked=1
    echo "- UNLINKED $memdir ($(find "$memdir" -maxdepth 1 -name '*.md'|wc -l|tr -d ' ') memories) — add via refresh-project-symlinks.sh, then ingest"
  fi
done
[ "$found_unlinked" = 0 ] && echo "(none — every live project memory dir is symlinked)"

# NOTE: log.md is append-only history/prose that legitimately quotes [[...]]
# link syntax as text; it is excluded from all link scans below.
WIKI() { find wiki -name '*.md' ! -name 'log.md' -print0; }

section "2. Dead wiki -> raw source links"
WIKI | xargs -0 grep -hoE '\[\[(projects|slack|linear|notion)/[^]|#]+' \
  | sed 's/^\[\[//' | sort -u | while read -r t; do [ -e "$t.md" ] || echo "$t"; done > /tmp/_dead_raw.txt
# actionable = dead occurrences NOT annotated with the (raw pruned) marker
actionable=$(WIKI | xargs -0 grep -hoE '\[\[(projects|slack|linear|notion)/[^]|#]+\]\](_\(raw pruned[^)]*\)_)?' \
  | while read -r m; do t=$(printf '%s' "$m" | sed -E 's/^\[\[//; s/\]\].*//');
      if [ ! -e "$t.md" ] && ! printf '%s' "$m" | grep -q '_(raw pruned'; then echo x; fi; done | wc -l | tr -d ' ')
echo "Distinct dead-target raw links: $(wc -l < /tmp/_dead_raw.txt | tr -d ' ')  (most are ACCEPTED — annotated \`_(raw pruned)_\`, source purged/consolidated)"
echo "ACTIONABLE (dead + UNannotated) occurrences: $actionable"
echo '```'
echo "dead targets by class:"; sed -E 's#/.*##' /tmp/_dead_raw.txt | sort | uniq -c
echo '```'

section "3. Dead wiki -> wiki links (target|referencing-pages)"
WIKI | xargs -0 grep -hoE '\[\[wiki/[^]|#]+' | sed 's/^\[\[//' | sort -u \
  | while read -r t; do [ -f "$t.md" ] || echo "$t"; done > /tmp/_dead_wiki.txt
echo "Total dead wiki->wiki links: $(wc -l < /tmp/_dead_wiki.txt | tr -d ' ')  (expected: only the <name> template placeholder)"
echo '```'
while read -r t; do
  refs=$(grep -rl "\[\[$t" wiki --include='*.md' ! -name 'log.md' | sed 's#wiki/##;s#\.md$##' | paste -sd', ' -)
  printf '%-55s <- %s\n' "$t" "$refs"
done < /tmp/_dead_wiki.txt
echo '```'

section "4. Malformed links"
echo '```'
echo "full-encoded-path links (embed ~/.claude path):"
WIKI | xargs -0 grep -hoE '\[\[projects/-Users-[^]|#]+' | sort | uniq -c
echo ".md-suffixed raw links (break to .md.md):"
WIKI | xargs -0 grep -hoE '\[\[(slack|projects|linear|notion)/[^]|#]+\.md\]\]' | grep -v '_(raw pruned' | sort -u
echo '```'

section "5. RAW PURITY violations — [[wiki/...]] backlinks inside raw files"
viol=$(grep -rlE '\[\[wiki/' linear notion slack projects 2>/dev/null | wc -l | tr -d ' ')
echo "raw files containing [[wiki/...]] backlinks (should be 0): $viol"
if [ "$viol" != 0 ]; then
  echo '```'
  grep -rlE '\[\[wiki/' linear notion slack projects 2>/dev/null | sort | head -40
  echo "(these are sync/agent overreach — raw must not carry wiki synthesis; the next sync of that class should overwrite in-window files)"
  echo '```'
fi
