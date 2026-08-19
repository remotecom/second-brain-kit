#!/usr/bin/env bash
# tests/run.sh — vault-kit test suite. Plain bash, zero dependencies beyond
# what README already requires (bash, git, date, find, sed, grep).
#
#   bash tests/run.sh
#
# The fixture vault is BUILT here rather than committed, because these tests
# depend on file mtimes and git does not preserve mtimes. A committed fixture
# would silently test nothing.
set -uo pipefail
cd "$(dirname "$0")/.."
VAULT_ROOT="$(pwd)"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"; }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
has()  { if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else bad "$1" "contains: $3" "$(printf '%s' "$2" | head -3)"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q -- "$3"; then bad "$1" "NOT contains: $3" "found it"; else ok "$1"; fi; }
sect() { printf '\n== %s\n' "$1"; }

# ===========================================================================
sect "1. BSD find cutoff parsing (CRITICAL — the ingest delta walk depends on it)"
# ===========================================================================
# Measured on macOS 15.6.1 / BSD find. See scripts/delta-walk.sh.
TD=$(mktemp -d); trap 'rm -rf "$TD"' EXIT
touch -t 202608010000 "$TD/old.md"
touch -t 202608150000 "$TD/mid.md"
touch -t 202608180000 "$TD/new.md"
W="2026-08-14T00:00:00Z"          # exactly what `date -u +"%Y-%m-%dT%H:%M:%SZ"` writes

# (a) The raw watermark string is REJECTED by BSD find.
raw_out=$(find -L "$TD" -type f -name '*.md' -newermt "$W" 2>&1); raw_rc=$?
is  "raw Z-suffixed cutoff is rejected (rc!=0)"      "1" "$raw_rc"
has "raw Z-suffixed cutoff explains why"             "$raw_out" "Can't parse date/time"

# (b) ...and the rejection goes SILENT the way ingest actually invokes it.
silent=$(find -L "$TD" -type f -name '*.md' -newermt "$W" 2>/dev/null | wc -l | tr -d ' ')
is  "Z-suffixed cutoff yields a SILENT zero via 2>/dev/null (the trap)" "0" "$silent"

# (c) Stripping Z is what actually fixes it.
n=$(find -L "$TD" -type f -name '*.md' -newermt "$(printf '%s' "$W" | sed 's/Z$//')" 2>/dev/null | wc -l | tr -d ' ')
is  "s/Z\$// cutoff matches exactly the 2 files newer than the watermark" "2" "$n"

# (d) The T->space substitution is harmless but NOT load-bearing on this
#     platform. CLAUDE.md claims the T form under-filters and returns too many;
#     that does NOT reproduce on macOS 15.6.1. Pinned so a future change of
#     behavior is caught rather than assumed.
n=$(find -L "$TD" -type f -name '*.md' -newermt "$(printf '%s' "$W" | sed 's/Z$//; s/T/ /')" 2>/dev/null | wc -l | tr -d ' ')
is  "s/Z\$//; s/T/ / cutoff matches the same 2 files" "2" "$n"

# ===========================================================================
sect "2. scripts/linkrot-lint.sh actually executes"
# ===========================================================================
# This is the test that would have caught the live bug: the script cd'd above
# the vault root, exited 1, and printed a clean-LOOKING partial report.
lint_out=$(bash scripts/linkrot-lint.sh 2>&1); lint_rc=$?
is  "linkrot-lint.sh exits 0"                   "0" "$lint_rc"
is  "linkrot-lint.sh emits all 6 sections"      "6" "$(printf '%s' "$lint_out" | grep -c '^## ')"
has "…including section 2 (first one that used to be skipped)" "$lint_out" "## 2."
has "…and section 5 (last one)"                 "$lint_out" "## 5."

# ===========================================================================
sect "3. linkrot-lint.sh detects the NEW raw classes"
# ===========================================================================
PROBE_WIKI="wiki/concepts/_test_probe.md"
PROBE_RAW="gmail/threads/_test_probe.md"
cleanup_probes() { rm -f "$VAULT_ROOT/$PROBE_WIKI" "$VAULT_ROOT/$PROBE_RAW"; }
trap 'rm -rf "$TD"; cleanup_probes' EXIT
cat > "$PROBE_WIKI" <<'PROBE'
---
name: test probe
type: wiki
---
- [[gdrive/files/does-not-exist]]
- [[gmail/threads/also-missing]]
- [[gcal/1999-01-01]]
- [[slack/1999-01-01]]_(raw pruned)_
PROBE
printf -- '- [[wiki/concepts/test-probe]]\n' > "$PROBE_RAW"

probe_out=$(bash scripts/linkrot-lint.sh 2>&1)
has "dead gdrive link is reported"   "$probe_out" "gdrive"
has "dead gmail link is reported"    "$probe_out" "gmail"
has "dead gcal link is reported"     "$probe_out" "gcal"
is  "3 unannotated dead links are ACTIONABLE, the _(raw pruned)_ one is not" \
    "ACTIONABLE (dead + UNannotated) occurrences: 3" \
    "$(printf '%s' "$probe_out" | grep '^ACTIONABLE')"
has "raw-purity violation inside gmail/threads is caught" "$probe_out" "$PROBE_RAW"
cleanup_probes

# ===========================================================================
sect "4. scripts/delta-walk.sh"
# ===========================================================================
dw=$(bash scripts/delta-walk.sh 2>/dev/null)
for cls in "projects/=" "slack/=" "linear/issues=" "linear/projects=" \
           "linear/initiatives=" "linear/docs=" "notion/pages=" \
           "notion/databases=" "gdrive/files=" "gmail/threads=" "gcal/="; do
  has "Deltas line names $cls (a class must never be ABSENT)" "$dw" "$cls"
done
is "Deltas line reports exactly 11 classes" "11" "$(printf '%s' "$dw" | tr ',' '\n' | grep -c '=')"

# delta-walk must survive the raw watermark format without silently zeroing.
# Plant a REAL raw file with a known mtime — do not lean on README.md, which
# delta-walk deliberately excludes as kit documentation rather than content.
PROBE_GCAL="gcal/_test_probe.md"
cleanup_all() { rm -rf "$TD"; cleanup_probes; rm -f "$VAULT_ROOT/$PROBE_GCAL"; }
trap cleanup_all EXIT
printf -- '# probe\n' > "$PROBE_GCAL"; touch -t 202608180000 "$PROBE_GCAL"

dw2=$(bash scripts/delta-walk.sh "2020-01-01T00:00:00Z" 2>/dev/null)
has "delta-walk handles a Z-suffixed watermark (does not silently zero)" "$dw2" "Deltas walked:"
n_gcal=$(printf '%s' "$dw2" | tr ',' '\n' | grep 'gcal/=' | tr -dc '0-9')
is "delta-walk sees a raw file newer than a 2020 watermark" "1" "${n_gcal:-0}"

# ...and must NOT see it when the watermark is newer than the file.
dw3=$(bash scripts/delta-walk.sh "2026-08-19T00:00:00Z" 2>/dev/null)
n_gcal3=$(printf '%s' "$dw3" | tr ',' '\n' | grep 'gcal/=' | tr -dc '0-9')
is "delta-walk excludes a raw file older than the watermark" "0" "${n_gcal3:-0}"

# README.md is kit docs, never a delta.
is "delta-walk does not count README.md as raw content" "0" \
   "$(printf '%s' "$dw2" | tr ',' '\n' | grep 'slack/=' | tr -dc '0-9')"
rm -f "$PROBE_GCAL"

# ===========================================================================
sect "5. Leak test — BOTH directions"
# ===========================================================================
for f in gdrive/files/x.md gmail/threads/x.md gcal/2026-08-18.md \
         gdrive/.allowlist gmail/.last-sync gdrive/.state.json; do
  if git check-ignore -q "$f"; then ok "IGNORED  $f"; else bad "IGNORED $f" "ignored" "TRACKED — LEAK"; fi
done
for f in gdrive/files/README.md gmail/threads/README.md gcal/README.md \
         gdrive/files/.gitkeep tests/run.sh; do
  if git check-ignore -q "$f"; then bad "trackable $f" "trackable" "IGNORED — dir would vanish"; else ok "trackable  $f"; fi
done
# A committed fixture under tests/ must not be swallowed by watermark globs.
for f in tests/fixture/slack/.last-sync tests/fixture/wiki/.last-ingest; do
  if git check-ignore -q "$f"; then bad "fixture $f survives gitignore" "trackable" "IGNORED"; else ok "fixture path $f is trackable"; fi
done

printf '\n=========================\n  PASS %s   FAIL %s\n=========================\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
