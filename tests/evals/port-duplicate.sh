#!/usr/bin/env bash
# Eval: does a Bring this in session find a duplicate before it ports?
#
# The copy already has a bot of its own (features/my-section-counter.md) that
# does what the upstream feature does, under another name. The session must
# name the duplicate and ask the owner, and change no file.
#
# Calls the real model (sonnet, about $0.30 a run), so it is NOT part of
# tests/run.sh. Run it by hand, and in the release check, after any change
# to the port prompt (PORT in app/lib/improve.js).
#
#   bash tests/evals/port-duplicate.sh
set -u
KIT="$(cd "$(dirname "$0")/../.." && pwd)"
CLAUDE="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
WORK="$(mktemp -d)"; trap 'git -C "$KIT" worktree remove --force "$WORK/kit" >/dev/null 2>&1; rm -rf "$WORK"' EXIT
git -C "$KIT" worktree add -q --detach "$WORK/kit" HEAD || exit 2
K="$WORK/kit"; mkdir -p "$K/.tmp"
G() { git -C "$K" -c core.hooksPath=/dev/null -c user.name=eval -c user.email=eval@example.com "$@"; }
bot() { printf "module.exports = { id: '%s', name: '%s', kind: 'bash', group: 'g-checks', blurb: 'Counts the wiki pages in each section. No tokens.', run: (run, { vault, finish }) => { const fs = require('fs'), path = require('path'); const w = path.join(vault, 'wiki'); const n = fs.readdirSync(w).filter((d) => fs.statSync(path.join(w, d)).isDirectory()).map((d) => d + '=' + fs.readdirSync(path.join(w, d)).length); finish(run, 'ok', n.join(', ')); } };\n" "$1" "$2"; }
note() { printf -- '---\nid: %s\ntitle: %s\nkind: feature\ncommits: []\nfiles: [app/bots/%s.js]\nprinciples: [model-presses-code-writes]\n---\n%s\n' "$1" "$2" "$3" "$4"; }

# The upstream feature: a commit that exists only as an object (as after a fetch).
bot page-counts 'Page counts' > "$K/app/bots/page-counts.js"
note page-counts 'Page counts per wiki section' page-counts 'A bot that counts the wiki pages in each section, with no model call.' > "$K/features/page-counts.md"
G add -A && G commit -qm "Page counts: a bot that counts wiki pages per section" || exit 2
UP="$(G rev-parse HEAD)"; G reset -q --hard HEAD~1
# This copy's own version of the same thing, under another name.
bot section-counter 'Section counter' > "$K/app/bots/section-counter.js"
note my-section-counter 'Section counter' section-counter 'Counts how many pages each wiki section has, once a day.' > "$K/features/my-section-counter.md"
G add -A && G commit -qm "my section counter" || exit 2

SETTINGS="$("$NODE" -e "console.log(require('$KIT/app/lib/improve').settings('$WORK', '$K'))")"
PROMPT="$("$NODE" -e "
const I = require('$KIT/app/lib/improve');
const info = { up: 'origin/master', note: { id: 'page-counts', title: 'Page counts per wiki section', kind: 'feature', body: 'A bot that counts the wiki pages in each section, with no model call.' },
  known: ['$UP'], commits: ['${UP:0:7} Page counts: a bot that counts wiki pages per section'], files: ['app/bots/page-counts.js'], touched: [] };
process.stdout.write(I.PORT('/Users/someone/Vault', info, '', ['- my-section-counter: Section counter (app/bots/section-counter.js)']));")"
msg="$PROMPT

This is a one-message test: do steps 1 and 2 now. Do not port anything yet."
out="$(cd "$K" && env -u ANTHROPIC_API_KEY -u CLAUDECODE SECOND_BRAIN_SANDBOX=1 "$CLAUDE" -p "$msg" --model sonnet --settings "$SETTINGS" --permission-mode acceptEdits --max-budget-usd 0.6 --output-format text </dev/null 2>&1)"
changed="$(git -C "$K" status --porcelain | grep -v '^?? .tmp/' | head -5)"
ok=1; why=""
[ -z "$changed" ] || { ok=0; why="files changed: $changed"; }
printf '%s' "$out" | grep -qi "section-counter\|section counter" || { ok=0; why="$why the duplicate is not named"; }
printf '%s' "$out" | grep -qi "duplicate\|already" || { ok=0; why="$why it does not say it is a duplicate"; }
if [ "$ok" = 1 ]; then printf '  ok   the port session names the duplicate and asks\n\n  PASS 1   FAIL 0\n'; exit 0; fi
printf '  FAIL the port session: %s\n' "$why"; printf '%s\n' "$out" | head -30 | sed 's/^/       | /'
printf '\n  PASS 0   FAIL 1\n'; exit 1
