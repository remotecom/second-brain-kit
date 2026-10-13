#!/bin/bash
# fresh-install.sh: the repeatable end-to-end test of a new install.
#
# Clones the kit, runs `second-brain setup` into a throwaway vault on its own
# port and state folder (never the live app, never a login item), runs a short
# first run on real connectors, applies a wiki shape, ingests, and checks the
# result. Writes report.md next to the vault and prints PASS or FAIL.
#
#   bash tests/fresh-install.sh --from-vault ~/SecondBrain
#   bash tests/fresh-install.sh --from-vault ~/SecondBrain --repo https://github.com/remotecom/second-brain-kit.git --branch master
#
#   --from-vault <dir>  copy identity, connectors, Linear scope and allowlists
#                       from this vault's config (its raw and wiki are NOT
#                       copied); without it, finish the Setup page by hand
#   --repo <url|path>   what to clone (default: this checkout)
#   --branch <name>     default: the current branch of this checkout
#   --days <n>          first-run back-fill: 3 (default), 7, 14 or 30
#   --shape <s>         suggest (default: Sonnet reads the synced names) or a
#                       preset: partnerships, engineering, sales, product
#   --role <text>       one line on what the owner does (for suggest)
#   --port <n>          default 19310
#   --dir <dir>         where to put the test (default: a new temp folder)
#
# Cost: one first run on your claude.ai plan (about $3-4 at 3 days). The test
# folder is kept for a look; delete it when done. The test app is stopped at
# the end.
set -uo pipefail

KIT_HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$KIT_HERE"; BRANCH="$(git -C "$KIT_HERE" rev-parse --abbrev-ref HEAD)"
FROM=""; DAYS=3; SHAPE=suggest; ROLE=""; PORT=19310; DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from-vault) FROM="$2"; shift 2;; --repo) REPO="$2"; shift 2;; --branch) BRANCH="$2"; shift 2;;
    --days) DAYS="$2"; shift 2;; --shape) SHAPE="$2"; shift 2;; --role) ROLE="$2"; shift 2;;
    --port) PORT="$2"; shift 2;; --dir) DIR="$2"; shift 2;;
    -h|--help) sed -n '2,27p' "$0"; exit 0;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done

NODE="$(command -v node || true)"
for n in /opt/homebrew/bin/node /usr/local/bin/node; do [ -n "$NODE" ] && break; [ -x "$n" ] && NODE="$n"; done
[ -n "$NODE" ] || { echo "node not found" >&2; exit 2; }
case "$DAYS" in 3|7|14|30) ;; *) echo "--days must be 3, 7, 14 or 30" >&2; exit 2;; esac
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is in use; pick another with --port" >&2; exit 2; fi
[ -z "$FROM" ] || [ -f "$FROM/config.yaml" ] || { echo "--from-vault: no config.yaml in $FROM" >&2; exit 2; }

DIR="${DIR:-$(mktemp -d "${TMPDIR:-/tmp}/sb-fresh-XXXXXX")}"
mkdir -p "$DIR"
KIT="$DIR/kit"; VAULT="$DIR/vault"; STATE="$DIR/state"; REPORT="$DIR/report.md"
export SECOND_BRAIN_STATE_DIR="$STATE"
FAILS=0; T0=$(date +%s)
PLIST="$HOME/Library/LaunchAgents/dev.secondbrain.app.plist"
PLIST_BEFORE="$(shasum "$PLIST" 2>/dev/null)"
say() { echo "$*"; echo "$*" >> "$REPORT"; }
check() { if [ "$1" = ok ]; then say "- [x] $2"; else say "- [ ] $2 **FAILED**${3:+: $3}"; FAILS=$((FAILS + 1)); fi; }
: > "$REPORT"
say "# Fresh install test, $(date -u +%Y-%m-%dT%H:%MZ)"
say ""; say "Repo \`$REPO\` branch \`$BRANCH\` · first run $DAYS day(s) · shape $SHAPE · port $PORT · folder \`$DIR\`"; say ""

# --- 1. clone + setup ------------------------------------------------------------
say "## 1. Install"
git clone -q -b "$BRANCH" "$REPO" "$KIT" 2>>"$DIR/clone.log"; check "$([ -x "$KIT/app/bin/second-brain" ] && echo ok)" "clone ($(git -C "$KIT" rev-parse --short HEAD 2>/dev/null))"
"$KIT/app/bin/second-brain" setup --vault "$VAULT" --port "$PORT" --no-login-item --no-obsidian --yes </dev/null > "$DIR/setup.log" 2>&1
check "$([ -f "$VAULT/config.yaml" ] && [ -f "$VAULT/wiki/index.md" ] && grep -q '^<!-- kit:begin' "$VAULT/CLAUDE.md" && echo ok)" "setup made the vault (config.yaml, wiki/index.md, kit block)"
check "$([ "$(shasum "$PLIST" 2>/dev/null)" = "$PLIST_BEFORE" ] && echo ok)" "the live login item was not touched"

# --- 2. config: the owner's identity and scope, a short window, no schedule ----------
"$NODE" - "$KIT" "$VAULT" "$FROM" "$DAYS" <<'JS'
const [kit, vault, from, days] = process.argv.slice(2);
const fs = require('fs'), path = require('path');
const C = require(path.join(kit, 'app/lib/config'));
const set = { bootstrap_days: Number(days), 'schedule.enabled': false };
if (from) {
  const c = C.getConfig(from);
  for (const k of ['name', 'email', 'slack_user_id', 'notion_user_id', 'timezone']) if (c.owner[k]) set[`owner.${k}`] = c.owner[k];
  for (const k of Object.keys(c.connectors || {})) if (c.connectors[k]) set[`connectors.${k}`] = c.connectors[k];
  for (const k of ['slack', 'linear', 'notion', 'gcal', 'gdrive']) set[`sources.${k}.enabled`] = !!c.sources[k].enabled;
  set['sources.linear.scope'] = c.sources.linear.scope;
  set['sources.gcal.calendars'] = c.sources.gcal.calendars;
  set['sources.gdrive.exclude_folders'] = c.sources.gdrive.exclude_folders;
  // Scope cache and allowlists are setup state, not raw content.
  for (const f of ['linear/.initiative-scope.json', 'notion/.allowlist', 'notion/.user-id', 'gdrive/.allowlist']) {
    try { fs.mkdirSync(path.dirname(path.join(vault, f)), { recursive: true }); fs.copyFileSync(path.join(from, f), path.join(vault, f)); } catch {}
  }
}
C.writeValues(vault, set);
JS
check "$([ $? = 0 ] && echo ok)" "config set (first run $DAYS days, schedule off${FROM:+, identity and scope from $FROM})"

# --- 3. start the test app -------------------------------------------------------------
(cd "$KIT/app" && SECOND_BRAIN_PORT="$PORT" nohup "$NODE" server.js >> "$STATE/server.log" 2>&1 &)
for _ in $(seq 1 50); do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 0.2; done
TOKEN="$(cat "$STATE/token" 2>/dev/null)"
api() { curl -s -X "${3:-POST}" -H "Content-Type: application/json" -H "X-Brain-Token: $TOKEN" "http://localhost:$PORT$1" ${2:+-d "$2"}; }
stop() { kill "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null)" 2>/dev/null; }
trap stop EXIT
check "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" | grep -q 200 && echo ok)" "the test app answers on port $PORT"

if [ -z "$FROM" ]; then
  echo; echo "Open http://localhost:$PORT, finish Setup steps 1-4 (connectors, you, Linear scope, privacy), then press Enter here."
  read -r _
fi
DOC="$("$KIT/app/bin/second-brain" doctor 2>&1)"
check "$(echo "$DOC" | grep -q 'Nothing stops the bots' && echo ok)" "doctor: nothing stops the bots" "$(echo "$DOC" | grep -m1 '✗' || true)"

# --- 4. first run: syncs, then the ingest waits for a shape ----------------------------
runs() { ls "$VAULT/.bot/runs" 2>/dev/null; }
waitfor() { # $1 = bot id, $2 = max seconds; waits for a run record newer than now
  local before; before=$(runs | grep -c -- "-$1.json"); for _ in $(seq 1 $(( $2 / 10 ))); do [ "$(runs | grep -c -- "-$1.json")" -gt "$before" ] && return 0; sleep 10; done; return 1; }
last() { "$NODE" -e 'const fs=require("fs"),p=require("path");const d=process.argv[1];const f=fs.readdirSync(d).filter(n=>n.endsWith(`-${process.argv[2]}.json`)).sort().pop();if(!f)process.exit(1);const r=JSON.parse(fs.readFileSync(p.join(d,f),"utf8"));console.log(`${r.status}\t${r.summary}\t${(r.costUsd||0).toFixed(2)}`)' "$VAULT/.bot/runs" "$1"; }
say ""; say "## 2. First run"
api /api/setup/first-run "{\"bootstrap_days\":$DAYS}" > /dev/null
waitfor morning 3600; check "$([ $? = 0 ] && echo ok)" "the Morning run ended within an hour"
for b in sync-slack sync-gcal sync-linear sync-notion sync-gdrive brief; do
  l="$(last $b || echo "never")"; st="${l%%	*}"
  check "$([ "$st" = ok ] || [ "$st" = warn ] && echo ok)" "$b: $(echo "$l" | tr '\t' ' ' | cut -c1-140)"
done
l="$(last morning)"; say "- Morning: $(echo "$l" | tr '\t' ' ')"
check "$(echo "$l" | grep -q 'waits for wiki shape' && echo ok)" "the first ingest waited for a wiki shape"

# --- 5. wiki shape, then the first ingest ----------------------------------------------
say ""; say "## 3. Wiki shape and the first ingest"
if [ "$SHAPE" = suggest ]; then
  R="$(api /api/setup/shape/suggest "$("$NODE" -e 'console.log(JSON.stringify({role:process.argv[1]}))' "$ROLE")")"
else
  R="$(api /api/setup/shape/draft "{\"preset\":\"$SHAPE\"}")"
fi
SECS="$(echo "$R" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.error?"ERROR "+j.error:j.draft.sections.map(x=>x.name).join(", "))}catch{console.log("ERROR bad reply")}})')"
check "$(echo "$SECS" | grep -qv '^ERROR' && echo ok)" "shape ($SHAPE): $SECS"
api /api/setup/shape/apply '{}' > "$DIR/apply.json"
check "$(grep -q '"applied"' "$DIR/apply.json" && echo ok)" "the shape applied (config, folders, kit block)" "$(head -c 200 "$DIR/apply.json")"
api /api/brain/bots/ingest/run '{}' > /dev/null
waitfor ingest 3600
l="$(last ingest || echo never)"; st="${l%%	*}"
check "$([ "$st" = ok ] || [ "$st" = warn ] && echo ok)" "ingest: $(echo "$l" | tr '\t' ' ')"
api /api/brain/bots/verify/run '{}' > /dev/null
waitfor verify 1200
l="$(last verify || echo never)"; say "- verify: $(echo "$l" | tr '\t' ' ')"

# --- 6. what the wiki looks like ---------------------------------------------------------
say ""; say "## 4. The wiki"
"$NODE" - "$KIT" "$VAULT" "$REPORT" <<'JS' || FAILS=$((FAILS + 1))
const [kit, vault, report] = process.argv.slice(2);
const fs = require('fs'), path = require('path');
const C = require(path.join(kit, 'app/lib/config'));
const secs = C.getConfig(vault).wiki.sections.map(String);
const out = [], fail = [];
const pages = [];
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.md') && !['README.md', 'index.md', 'log.md'].includes(f.name)) pages.push(p); } };
walk(path.join(vault, 'wiki'));
const rel = (p) => path.relative(path.join(vault, 'wiki'), p);
const outside = pages.filter((p) => !secs.includes(rel(p).split(path.sep)[0]));
let dup = 0, mdLinks = 0, deadRaw = 0, noSources = 0;
for (const p of pages) {
  const t = fs.readFileSync(p, 'utf8');
  const fm = (t.split(/^---$/m)[1] || '');
  const src = [...fm.matchAll(/^\s+-\s+(.+)$/gm)].map((m) => m[1].trim().replace(/^["']|["']$/g, ''));
  if (!src.length) noSources++;
  const k = src.map((s) => s.replace(/\.md$/, ''));
  dup += k.length - new Set(k).size;
  mdLinks += (t.match(/\[\[[^\]|#\n]+\.md(?:[#|][^\]\n]*)?\]\]/g) || []).length;
  for (const m of t.matchAll(/\[\[((?:projects|slack|linear|notion|gdrive|gmail|gcal)\/[^\]|#\n]+)/g)) if (!fs.existsSync(path.join(vault, `${m[1].replace(/\.md$/, '')}.md`))) deadRaw++;
}
const per = Object.fromEntries(secs.map((s) => [s, pages.filter((p) => rel(p).startsWith(`${s}${path.sep}`)).length]));
const idx = fs.readFileSync(path.join(vault, 'wiki', 'index.md'), 'utf8');
const unindexed = pages.filter((p) => !idx.includes(`[[wiki/${rel(p).replace(/\.md$/, '')}`)).length;
const line = (ok, what) => { out.push(`- [${ok ? 'x' : ' '}] ${what}${ok ? '' : ' **FAILED**'}`); if (!ok) fail.push(what); };
line(pages.length > 0, `${pages.length} wiki page(s): ${Object.entries(per).filter(([, n]) => n).map(([s, n]) => `${s} ${n}`).join(', ')}`);
line(!outside.length, `every page is in a shape section${outside.length ? ` (outside: ${outside.map(rel).join(', ')})` : ''}`);
line(dup === 0, `no source cited twice (${dup})`);
line(mdLinks === 0, `no [[x.md]] links (${mdLinks})`);
line(deadRaw === 0, `no dead wiki → raw links (${deadRaw})`);
line(noSources === 0, `every page lists its sources (${noSources} without)`);
line(unindexed === 0, `every page is in wiki/index.md (${unindexed} missing)`);
fs.appendFileSync(report, out.join('\n') + '\n');
console.log(out.join('\n'));
process.exit(fail.length ? 1 : 0);
JS
[ $? = 0 ] || true

# --- 7. summary --------------------------------------------------------------------------
TOTAL="$("$NODE" -e 'const fs=require("fs"),p=require("path");const d=process.argv[1];let c=0;for(const f of fs.readdirSync(d))try{c+=JSON.parse(fs.readFileSync(p.join(d,f),"utf8")).costUsd||0}catch{};console.log(c.toFixed(2))' "$VAULT/.bot/runs")"
say ""; say "## Result"
say "$( [ "$FAILS" = 0 ] && echo PASS || echo "FAIL ($FAILS check(s))" ) · $(( ($(date +%s) - T0) / 60 )) min · \$$TOTAL of plan usage"
say ""; say "The test app is stopped. The vault stays in \`$VAULT\` for a look (open it in Obsidian, or start the app again with SECOND_BRAIN_STATE_DIR=$STATE $KIT/app/bin/second-brain). Delete \`$DIR\` when done."
[ "$FAILS" = 0 ]
