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
# Declared before the trap so cleanup_all can reference it even if the suite
# dies before section 4 creates it. It previously survived only because its
# literal path was byte-identical to PROBE_RAW, which cleanup_probes happens to
# sweep — a coincidence, not a guarantee, that any rename would have silently
# removed. A leak here is invisible (gmail/threads is gitignored) and permanent:
# a stray file flips delta-walk from SKIPPED-not-implemented to a stale count.
PROBE_GMAIL="gmail/threads/_test_probe_gmail.md"
cleanup_all() {
  rm -rf "$TD"; cleanup_probes
  rm -f "$VAULT_ROOT/$PROBE_GCAL" "$VAULT_ROOT/$PROBE_GMAIL"
}
trap cleanup_all EXIT
printf -- '# probe\n' > "$PROBE_GCAL"; touch -t 202608180000 "$PROBE_GCAL"

# Assert on the DELTA this probe causes, never on an absolute count — a real
# vault has real content and absolute counts make the suite depend on it.
count_gcal() { bash scripts/delta-walk.sh "$1" 2>/dev/null | tr ',' '\n' | grep 'gcal/=' | tr -dc '0-9'; }

rm -f "$PROBE_GCAL"
before_old=$(count_gcal "2020-01-01T00:00:00Z")   # watermark older than probe
before_new=$(count_gcal "2026-08-19T00:00:00Z")   # watermark newer than probe
printf -- '# probe\n' > "$PROBE_GCAL"; touch -t 202608180000 "$PROBE_GCAL"
after_old=$(count_gcal "2020-01-01T00:00:00Z")
after_new=$(count_gcal "2026-08-19T00:00:00Z")

has "delta-walk handles a Z-suffixed watermark (does not silently zero)" \
    "$(bash scripts/delta-walk.sh "2020-01-01T00:00:00Z" 2>/dev/null)" "Deltas walked:"
is  "delta-walk COUNTS a raw file newer than the watermark (+1)" \
    "$(( before_old + 1 ))" "$after_old"
is  "delta-walk EXCLUDES a raw file older than the watermark (+0)" \
    "$before_new" "$after_new"

# README.md is kit docs, never a delta. slack/ holds only README.md.
is "delta-walk does not count README.md as raw content" "0" \
   "$(bash scripts/delta-walk.sh "2020-01-01T00:00:00Z" 2>/dev/null | tr ',' '\n' | grep 'slack/=' | tr -dc '0-9')"
rm -f "$PROBE_GCAL"

# --- Unimplemented classes report SKIPPED, never 0 -------------------------
# A class with no sync op that reports `0` is indistinguishable from a working
# source with an empty delta — a permanently dead source reading as a healthy
# one. This is the whole reason RAW_UNIMPLEMENTED exists.
. scripts/raw-classes.sh
is  "RAW_UNIMPLEMENTED is non-empty (gmail has no op yet)" \
    "gmail/threads" "$RAW_UNIMPLEMENTED"
has "gmail/threads reports SKIPPED, not a count" "$dw" "gmail/threads=SKIPPED-not-implemented"
hasnt "gmail/threads never reports a bare 0" "$dw" "gmail/threads=0"

# Every class NOT in RAW_UNIMPLEMENTED must still report a real number, or the
# SKIPPED path has leaked into implemented sources.
# Derived from RAW_SUBPATHS minus RAW_UNIMPLEMENTED so a class added later is
# covered automatically. The old hardcoded 4-item list checked 4 of 10.
for d in $RAW_SUBPATHS; do
  case " $RAW_UNIMPLEMENTED " in *" $d "*) continue ;; esac
  case "$d" in projects|slack|gcal) cls="$d/" ;; *) cls="$d" ;; esac
  v=$(printf '%s' "$dw" | tr ',' '\n' | grep -- "$cls=" | sed 's/.*=//' | tr -d ' ')
  case "$v" in
    ''|*[!0-9]*) bad "implemented class $cls reports a number" "digits" "$v" ;;
    *)           ok  "implemented class $cls reports a number ($v)" ;;
  esac
done

# A file appearing in an unimplemented class is a REAL finding and must surface
# as a count, not be swallowed by the SKIPPED label.
printf -- '# probe\n' > "$VAULT_ROOT/$PROBE_GMAIL"
dw_probe=$(bash scripts/delta-walk.sh "2020-01-01T00:00:00Z" 2>/dev/null)
hasnt "a file in an unimplemented class is NOT hidden behind SKIPPED" \
      "$dw_probe" "gmail/threads=SKIPPED"
has   "…it surfaces as a real count instead" "$dw_probe" "gmail/threads=1"
# The summary line and --list must agree; they are separate code paths.
list_probe=$(bash scripts/delta-walk.sh --list "2020-01-01T00:00:00Z" 2>/dev/null)
has "--list surfaces the file the summary line counted" "$list_probe" "_test_probe_gmail.md"
rm -f "$VAULT_ROOT/$PROBE_GMAIL"

# --- CLAUDE.md and config must not contradict each other -------------------
# config.example.yaml ships person_external_min: 2 because Gmail floods
# wiki/people/ at 1. CLAUDE.md used to hardcode "1 substantive thread".
hasnt "CLAUDE.md does not hardcode the old external-person threshold of 1" \
      "$(cat CLAUDE.md)" "External people (partner/vendor DRIs): \*\*1 substantive thread\*\*"
has   "CLAUDE.md documents a Sync (Gmail) op (config.example.yaml points at it)" \
      "$(cat CLAUDE.md)" "### Sync (Gmail)"
has   "config ships person_external_min: 2" "$(cat config.example.yaml)" "person_external_min: 2"

# ===========================================================================
sect "4b. Version skew — delta-walk.sh vs a stale raw-classes.sh"
# ===========================================================================
# scripts/ is copied piecemeal into other people's vaults, so a NEW
# delta-walk.sh beside a STALE raw-classes.sh is a real configuration. Before
# the guard, this aborted under `set -u` and printed NOTHING — no Deltas line
# at all, from the script whose one job is that a class never goes missing.
SKEW=$(mktemp -d)
# Covered by the trap from CREATION, not by the manual rm at the end of this
# section — the same bug class fixed for PROBE_GMAIL above. An interrupt
# between here and there would otherwise leak the dir in $TMPDIR permanently.
trap 'cleanup_all; rm -rf "$SKEW"' EXIT
mkdir -p "$SKEW/scripts"
for d in $RAW_SUBPATHS; do mkdir -p "$SKEW/$d"; done
mkdir -p "$SKEW/wiki"
cp "$VAULT_ROOT/scripts/delta-walk.sh" "$SKEW/scripts/"

# (a) Optional var absent -> degrade gracefully, still emit the full line.
printf '#!/usr/bin/env bash\nRAW_CLASSES="%s"\nRAW_SUBPATHS="%s"\n' \
  "$RAW_CLASSES" "$RAW_SUBPATHS" > "$SKEW/scripts/raw-classes.sh"
skew_out=$(cd "$SKEW" && bash scripts/delta-walk.sh 2>&1); skew_rc=$?
is  "stale raw-classes.sh (no RAW_UNIMPLEMENTED) still exits 0" "0" "$skew_rc"
has "…and still emits the Deltas line"        "$skew_out" "Deltas walked:"
has "…naming every class, none missing"       "$skew_out" "gmail/threads="
hasnt "…with no unbound-variable abort"       "$skew_out" "unbound variable"

# (b) REQUIRED var absent -> fail loudly, and name the file that is stale.
printf '#!/usr/bin/env bash\nRAW_CLASSES="projects"\n' > "$SKEW/scripts/raw-classes.sh"
hard_out=$(cd "$SKEW" && bash scripts/delta-walk.sh 2>&1); hard_rc=$?
is  "raw-classes.sh missing RAW_SUBPATHS exits non-zero" "1" "$hard_rc"
has "…and names the stale file, not a bash line number" "$hard_out" "raw-classes.sh"
hasnt "…and does not leak a bare unbound-variable error" "$hard_out" "unbound variable"

# (c) RAW_UNIMPLEMENTED with MULTIPLE entries — the shape the comment
#     anticipates when a second scaffolded source lands. Only the listed
#     classes may render SKIPPED.
printf '#!/usr/bin/env bash\nRAW_CLASSES="%s"\nRAW_SUBPATHS="%s"\nRAW_UNIMPLEMENTED="gmail/threads notion/pages"\n' \
  "$RAW_CLASSES" "$RAW_SUBPATHS" > "$SKEW/scripts/raw-classes.sh"
multi=$(cd "$SKEW" && bash scripts/delta-walk.sh 2>/dev/null)
has   "multi-entry: gmail/threads renders SKIPPED"  "$multi" "gmail/threads=SKIPPED-not-implemented"
has   "multi-entry: notion/pages renders SKIPPED"   "$multi" "notion/pages=SKIPPED-not-implemented"
hasnt "multi-entry: notion/databases does NOT (word-boundary match)" \
      "$multi" "notion/databases=SKIPPED"
has   "multi-entry: notion/databases still reports a count" "$multi" "notion/databases=0"
rm -rf "$SKEW"

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
