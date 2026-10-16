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
KIT="$(pwd)"
# The fixture vault: a fresh copy of the vault template, outside the kit (the
# kit is code; a vault is never inside it). Every script runs with it as the
# vault (SECOND_BRAIN_VAULT), and the probes below are written into it.
FIX=$(mktemp -d)
cp -R "$KIT/templates/vault/." "$FIX/"
export SECOND_BRAIN_VAULT="$FIX"
VAULT_ROOT="$FIX"
cd "$FIX"

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
TD=$(mktemp -d); trap 'rm -rf "$TD" "$FIX"' EXIT
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
lint_out=$(bash "$KIT"/scripts/linkrot-lint.sh 2>&1); lint_rc=$?
is  "linkrot-lint.sh exits 0"                   "0" "$lint_rc"
is  "linkrot-lint.sh emits all 7 sections"      "7" "$(printf '%s' "$lint_out" | grep -c '^## ')"
has "…including section 2 (first one that used to be skipped)" "$lint_out" "## 2."
has "…and section 6 (last one)"                 "$lint_out" "## 6."

# ===========================================================================
sect "3. linkrot-lint.sh detects the NEW raw classes"
# ===========================================================================
PROBE_WIKI="wiki/concepts/_test_probe.md"
PROBE_RAW="gmail/threads/_test_probe.md"
cleanup_probes() { rm -f "$VAULT_ROOT/$PROBE_WIKI" "$VAULT_ROOT/$PROBE_RAW"; }
trap 'rm -rf "$TD" "$FIX"; cleanup_probes' EXIT
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

probe_out=$(bash "$KIT"/scripts/linkrot-lint.sh 2>&1)
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
dw=$(bash "$KIT"/scripts/delta-walk.sh 2>/dev/null)
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
  rm -rf "$TD"; cleanup_probes; rm -rf "$FIX"
  rm -f "$VAULT_ROOT/$PROBE_GCAL" "$VAULT_ROOT/$PROBE_GMAIL"
}
trap cleanup_all EXIT
printf -- '# probe\n' > "$PROBE_GCAL"; touch -t 202608180000 "$PROBE_GCAL"

# Assert on the DELTA this probe causes, never on an absolute count — a real
# vault has real content and absolute counts make the suite depend on it.
count_gcal() { bash "$KIT"/scripts/delta-walk.sh "$1" 2>/dev/null | tr ',' '\n' | grep 'gcal/=' | tr -dc '0-9'; }

rm -f "$PROBE_GCAL"
before_old=$(count_gcal "2020-01-01T00:00:00Z")   # watermark older than probe
before_new=$(count_gcal "2026-08-19T00:00:00Z")   # watermark newer than probe
printf -- '# probe\n' > "$PROBE_GCAL"; touch -t 202608180000 "$PROBE_GCAL"
after_old=$(count_gcal "2020-01-01T00:00:00Z")
after_new=$(count_gcal "2026-08-19T00:00:00Z")

has "delta-walk handles a Z-suffixed watermark (does not silently zero)" \
    "$(bash "$KIT"/scripts/delta-walk.sh "2020-01-01T00:00:00Z" 2>/dev/null)" "Deltas walked:"
is  "delta-walk COUNTS a raw file newer than the watermark (+1)" \
    "$(( before_old + 1 ))" "$after_old"
is  "delta-walk EXCLUDES a raw file older than the watermark (+0)" \
    "$before_new" "$after_new"

# README.md is kit docs, never a delta. slack/ holds only README.md.
is "delta-walk does not count README.md as raw content" "0" \
   "$(bash "$KIT"/scripts/delta-walk.sh "2020-01-01T00:00:00Z" 2>/dev/null | tr ',' '\n' | grep 'slack/=' | tr -dc '0-9')"
rm -f "$PROBE_GCAL"

# --- Unimplemented classes report SKIPPED, never 0 -------------------------
# A class with no sync op that reports `0` is indistinguishable from a working
# source with an empty delta — a permanently dead source reading as a healthy
# one. This is the whole reason RAW_UNIMPLEMENTED exists.
. "$KIT"/scripts/raw-classes.sh
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
dw_probe=$(bash "$KIT"/scripts/delta-walk.sh "2020-01-01T00:00:00Z" 2>/dev/null)
hasnt "a file in an unimplemented class is NOT hidden behind SKIPPED" \
      "$dw_probe" "gmail/threads=SKIPPED"
has   "…it surfaces as a real count instead" "$dw_probe" "gmail/threads=1"
# The summary line and --list must agree; they are separate code paths.
list_probe=$(bash "$KIT"/scripts/delta-walk.sh --list "2020-01-01T00:00:00Z" 2>/dev/null)
has "--list surfaces the file the summary line counted" "$list_probe" "_test_probe_gmail.md"
rm -f "$VAULT_ROOT/$PROBE_GMAIL"

# --- CLAUDE.md and config must not contradict each other -------------------
# config.example.yaml ships person_external_min: 2 because Gmail floods
# wiki/people/ at 1. CLAUDE.md used to hardcode "1 substantive thread".
hasnt "the vault CLAUDE.md template does not hardcode the old external-person threshold of 1" \
      "$(cat "$KIT"/templates/vault/CLAUDE.md)" "External people (partner/vendor DRIs): \*\*1 substantive thread\*\*"
has   "the vault ops template documents a Sync (Gmail) op (config.example.yaml points at it)" \
      "$(cat "$KIT"/templates/vault/OPS.md)" "## Sync (Gmail)"
# Claude Code warns when CLAUDE.md is over 40k characters and every session
# loads all of it. The sync specs live in OPS.md (.bot/ops.md in the vault).
claude_md_chars=$(wc -c < "$KIT"/templates/vault/CLAUDE.md | tr -d ' ')
is "the vault CLAUDE.md template stays under 30k characters" "yes" "$([ "$claude_md_chars" -lt 30000 ] && echo yes || echo "no ($claude_md_chars)")"
has "the CLAUDE.md template points at .bot/ops.md" "$(cat "$KIT"/templates/vault/CLAUDE.md)" ".bot/ops.md"
has   "config ships person_external_min: 2" "$(cat "$KIT"/config.example.yaml)" "person_external_min: 2"

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
cp "$KIT/scripts/delta-walk.sh" "$SKEW/scripts/"

# (a) Optional var absent -> degrade gracefully, still emit the full line.
printf '#!/usr/bin/env bash\nRAW_CLASSES="%s"\nRAW_SUBPATHS="%s"\n' \
  "$RAW_CLASSES" "$RAW_SUBPATHS" > "$SKEW/scripts/raw-classes.sh"
skew_out=$(cd "$SKEW" && SECOND_BRAIN_VAULT="$SKEW" bash scripts/delta-walk.sh 2>&1); skew_rc=$?
is  "stale raw-classes.sh (no RAW_UNIMPLEMENTED) still exits 0" "0" "$skew_rc"
has "…and still emits the Deltas line"        "$skew_out" "Deltas walked:"
has "…naming every class, none missing"       "$skew_out" "gmail/threads="
hasnt "…with no unbound-variable abort"       "$skew_out" "unbound variable"

# (b) REQUIRED var absent -> fail loudly, and name the file that is stale.
printf '#!/usr/bin/env bash\nRAW_CLASSES="projects"\n' > "$SKEW/scripts/raw-classes.sh"
hard_out=$(cd "$SKEW" && SECOND_BRAIN_VAULT="$SKEW" bash scripts/delta-walk.sh 2>&1); hard_rc=$?
is  "raw-classes.sh missing RAW_SUBPATHS exits non-zero" "1" "$hard_rc"
has "…and names the stale file, not a bash line number" "$hard_out" "raw-classes.sh"
hasnt "…and does not leak a bare unbound-variable error" "$hard_out" "unbound variable"

# (c) RAW_UNIMPLEMENTED with MULTIPLE entries — the shape the comment
#     anticipates when a second scaffolded source lands. Only the listed
#     classes may render SKIPPED.
printf '#!/usr/bin/env bash\nRAW_CLASSES="%s"\nRAW_SUBPATHS="%s"\nRAW_UNIMPLEMENTED="gmail/threads notion/pages"\n' \
  "$RAW_CLASSES" "$RAW_SUBPATHS" > "$SKEW/scripts/raw-classes.sh"
multi=$(cd "$SKEW" && SECOND_BRAIN_VAULT="$SKEW" bash scripts/delta-walk.sh 2>/dev/null)
has   "multi-entry: gmail/threads renders SKIPPED"  "$multi" "gmail/threads=SKIPPED-not-implemented"
has   "multi-entry: notion/pages renders SKIPPED"   "$multi" "notion/pages=SKIPPED-not-implemented"
hasnt "multi-entry: notion/databases does NOT (word-boundary match)" \
      "$multi" "notion/databases=SKIPPED"
has   "multi-entry: notion/databases still reports a count" "$multi" "notion/databases=0"
rm -rf "$SKEW"

# ===========================================================================
sect "5. Leak test — BOTH directions"
# ===========================================================================
# The VAULT's .gitignore (copied from templates/vault by setup) is what keeps
# a person's data out of git if they version their vault. Test it in a
# throwaway repo built from the fixture vault.
git -C "$FIX" init -q 2>/dev/null
for f in gdrive/files/x.md gmail/threads/x.md gcal/2026-08-18.md config.yaml \
         gdrive/.allowlist gmail/.last-sync gdrive/.state.json; do
  if git -C "$FIX" check-ignore -q "$f"; then ok "IGNORED  $f"; else bad "IGNORED $f" "ignored" "TRACKED — LEAK"; fi
done
for f in gdrive/files/README.md gmail/threads/README.md gcal/README.md \
         gdrive/files/.gitkeep; do
  if git -C "$FIX" check-ignore -q "$f"; then bad "trackable $f" "trackable" "IGNORED — dir would vanish"; else ok "trackable  $f"; fi
done
# In the kit repo: the template's skeleton stays tracked, and so do tests.
for f in templates/vault/gcal/README.md templates/vault/gdrive/files/.gitkeep tests/run.sh \
         tests/fixture/slack/.last-sync tests/fixture/wiki/.last-ingest; do
  if git -C "$KIT" check-ignore -q "$f"; then bad "kit path $f is trackable" "trackable" "IGNORED"; else ok "kit path $f is trackable"; fi
done
# Nothing private may sit in the template (an old sync once left day files
# there): only READMEs, .gitkeep, .gitignore and CLAUDE.md.
stray=$(cd "$KIT/templates/vault" && find . -type f ! -name README.md ! -name .gitkeep ! -name .gitignore ! -path ./CLAUDE.md ! -path ./OPS.md | tr '\n' ' ')
is "templates/vault holds only skeleton files" "" "$stray"

# ===========================================================================
sect "5b. Contract: the app finds every delta file in a vault OUTSIDE the kit"
# ===========================================================================
# The scripts live in the kit and take --vault. The app reads the file list
# after the "--- delta files ---" marker; a missing marker made ingest see 0
# files and report "not due" forever (the 2026-10-05 portability audit).
CV=$(mktemp -d)
mkdir -p "$CV/wiki" "$CV/slack" "$CV/projects/demo"
printf -- '---\ndate: 2026-01-02\n---\n' > "$CV/slack/2026-01-02.md"
printf -- 'a memory\n' > "$CV/projects/demo/note.md"
cv_out=$(bash "$KIT"/scripts/delta-walk.sh --vault "$CV" --list 2>/dev/null)
has "delta-walk --vault prints the file-list marker" "$cv_out" "--- delta files ---"
has "…and lists a raw file of that vault"             "$cv_out" "slack/2026-01-02.md"
cv_cwd=$(cd "$CV" && env -u SECOND_BRAIN_VAULT bash "$KIT/scripts/delta-walk.sh" 2>/dev/null | grep -c '^Deltas walked:')
is  "with no --vault, the current directory is the vault" "1" "$cv_cwd"
nv_out=$(cd "$TD" && env -u SECOND_BRAIN_VAULT bash "$KIT/scripts/delta-walk.sh" 2>&1); nv_rc=$?
is  "a folder with no wiki/ is refused (rc 2)" "2" "$nv_rc"
has "…with a message that says how to fix it" "$nv_out" "Pass --vault"
NODE=$(command -v node || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -1)
if [ -n "$NODE" ]; then
  n_files=$("$NODE" -e "require('$KIT/app/lib/ingest').deltaWalk(process.argv[1]).then((r) => console.log(r.files.length))" "$CV")
  is "the app's deltaWalk() picks up both files" "2" "$n_files"
else
  printf '  skip deltaWalk() contract (node not found)\n'
fi
rm -rf "$CV"

# ===========================================================================
sect "6. Name check (no private names in anything that would be committed)"
# ===========================================================================
# The kit repo is PUBLIC. A denylist of partner, customer, people and ID terms
# lives OUTSIDE the repo (it is itself a list of private names), at
# $SECOND_BRAIN_DENYLIST or ~/.second-brain/denylist.txt. Every file git would
# commit (tracked + untracked-not-ignored) is checked, whole word, any case.
# No denylist = skip, so a fresh clone's test run still passes.
DENY="${SECOND_BRAIN_DENYLIST:-$HOME/.second-brain/denylist.txt}"
if [ -f "$DENY" ]; then
  # A temp file that cannot be made (a sandbox without a writable TMPDIR)
  # must FAIL here: an empty term list matches nothing and looked like a pass.
  if DL=$(mktemp 2>/dev/null) && grep -v '^#' "$DENY" | grep -v '^[[:space:]]*$' > "$DL" && [ -s "$DL" ]; then
    hits=$(cd "$KIT" && git ls-files -co --exclude-standard -z | xargs -0 grep -wiIlF -f "$DL" 2>/dev/null | tr '\n' ' ')
    rm -f "$DL"
    is "no denylist term in committable files" "" "$hits"
  else
    is "the denylist loads into a temp file (TMPDIR writable, list not empty)" "yes" "no"
  fi
else
  printf '  skip name check (no denylist at %s)\n' "$DENY"
fi

# ===========================================================================
sect "7. App unit tests (node --test app/test)"
# ===========================================================================
NODE=$(command -v node || ls /opt/homebrew/bin/node /usr/local/bin/node 2>/dev/null | head -1)
if [ -n "$NODE" ]; then
  # A per-test limit: a hang (a sandbox without pty devices, a server that
  # never answers) fails that test instead of stalling the whole run.
  nt_out=$(cd "$KIT" && "$NODE" --test --test-timeout=180000 app/test/*.test.js 2>&1); nt_rc=$?
  is "node --test passes ($(printf '%s' "$nt_out" | grep -E '^ℹ pass' | tr -dc '0-9') tests)" "0" "$nt_rc"
  [ "$nt_rc" = 0 ] || printf '%s\n' "$nt_out" | grep -E '^not ok|✖|Error' | head -20
else
  printf '  skip app unit tests (node not found)\n'
fi

# ===========================================================================
sect "8. One-line installer (install.sh)"
# ===========================================================================
bash -n "$KIT/install.sh"; is "install.sh parses" "0" "$?"
is "install.sh runs main on its last line (a cut-off download runs nothing)" 'main "$@"' "$(tail -1 "$KIT/install.sh")"
if [ -n "${SECOND_BRAIN_SANDBOX:-}" ]; then
  # A Make me better session runs these tests in the Claude Code sandbox,
  # where install.sh cannot run ps or open the terminal device (exit 126,
  # measured). Apply runs this section outside the sandbox.
  printf '  skip 5 installer dry-run checks (sandbox; Apply runs them)\n'
else
IS=$(mktemp -d)
printf '{\n  "vault": "%s/vault",\n  "port": 19399,\n  "kit": "%s"\n}\n' "$IS" "$KIT" > "$IS/settings.json"
in_out=$(SECOND_BRAIN_STATE_DIR="$IS" SECOND_BRAIN_DIR= SECOND_BRAIN_VAULT= bash "$KIT/install.sh" --dry-run --port 19399 </dev/null 2>&1); in_rc=$?
is "dry run exits 0" "0" "$in_rc"
is "dry run walks all 8 steps" "8" "$(printf '%s' "$in_out" | grep -cE '^.*[1-8]/8 ')"
is "an existing install keeps its kit (from settings.json)" "1" "$(printf '%s' "$in_out" | grep -cF "would run: git -C $KIT pull")"
is "an existing install keeps its vault, and other flags reach setup" "1" "$(printf '%s' "$in_out" | grep -cF "setup --vault $IS/vault --port 19399")"
is "dry run changes nothing" "no" "$([ -e "$IS/vault" ] && echo yes || echo no)"
rm -rf "$IS"
fi

printf '\n=========================\n  PASS %s   FAIL %s\n=========================\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
