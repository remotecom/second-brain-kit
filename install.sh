#!/usr/bin/env bash
# Second Brain installer: one command from a new Mac to the app's Setup page.
#
#   curl -fsSL https://raw.githubusercontent.com/remotecom/second-brain-kit/master/install.sh | bash
#
# It installs what is missing and skips what is there, so you can run it again:
#   1. Apple's developer tools (git, python3): opens Apple's dialog; you click Install.
#   2. Node 18 or newer, with Homebrew (Homebrew asks for your Mac password once).
#   3. Claude Code (Anthropic's installer, into ~/.local/bin; no password).
#   4. The claude.ai login: opens your browser; you log in.
#   5. Obsidian, for the graph view (optional; it asks first).
#   6. The kit: clones it, or pulls it when it is already there.
#   7. second-brain setup: the vault, the login item, the Dock app, the checks,
#      and the vault added to Obsidian's vault list.
#   8. Opens the Setup page. Connect your sources there (step 1).
#
# Options (environment variables):
#   SECOND_BRAIN_DIR     the kit folder     (default ~/second-brain-kit)
#   SECOND_BRAIN_VAULT   the vault folder   (default ~/SecondBrain)
#   SECOND_BRAIN_REPO    the git URL        (default the public repo)
#   SECOND_BRAIN_BRANCH  the branch         (default master)
#   SECOND_BRAIN_OBSIDIAN  yes or no: install Obsidian without asking
# An existing install keeps its own kit and vault (from ~/.second-brain/settings.json),
# so running this again only updates; it never moves you to a new vault.
#
# Flags (with `bash install.sh` or `curl ... | bash -s -- <flag>`):
#   --dry-run            print what it would do; change nothing
#   any other flag       goes to `second-brain setup` (for example --port 19320)
#
# Everything is inside main(), which runs on the last line. A download that
# stops halfway then runs nothing, instead of half a script.

set -euo pipefail

main() {
  local DRY=0 PASS=()
  for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) PASS+=("$a") ;; esac; done

  # An existing install: its settings name the kit and the vault it uses.
  local STATE="${SECOND_BRAIN_STATE_DIR:-$HOME/.second-brain}"
  setting() { [ -f "$STATE/settings.json" ] && sed -n "s/^ *\"$1\": *\"\(.*\)\",\{0,1\}$/\1/p" "$STATE/settings.json" | head -1; }
  local KIT="${SECOND_BRAIN_DIR:-$(setting kit)}"; KIT="${KIT:-$HOME/second-brain-kit}"
  local VAULT="${SECOND_BRAIN_VAULT:-$(setting vault)}"; VAULT="${VAULT:-$HOME/SecondBrain}"
  local REPO="${SECOND_BRAIN_REPO:-https://github.com/remotecom/second-brain-kit.git}"
  local BRANCH="${SECOND_BRAIN_BRANCH:-master}"

  # With `curl | bash`, stdin is the script. Prompts read the terminal instead:
  # its real device (/dev/ttys003), not /dev/tty. Claude Code runs on Bun, and
  # Bun stops with "EINVAL: invalid argument, kqueue" on /dev/tty.
  local TTY="" t
  t="$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')"
  if [ -n "$t" ] && [ "$t" != "??" ] && [ -r "/dev/$t" ]; then TTY="/dev/$t"
  elif { : </dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi

  say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
  ok()   { printf '  ✓ %s\n' "$*"; }
  todo() { printf '  → %s\n' "$*"; }
  die()  { printf '\n  ✗ %s\n' "$*" >&2; exit 1; }
  run()  { if [ "$DRY" = 1 ]; then todo "would run: $*"; else "$@"; fi; }

  say "Second Brain installer$([ "$DRY" = 1 ] && echo ' (dry run: nothing changes)')"
  [ "$(uname -s)" = Darwin ] || die "Second Brain runs on macOS only."

  # --- 1. Apple's developer tools --------------------------------------------
  say "1/8 Apple's developer tools (git, python3)"
  if xcode-select -p >/dev/null 2>&1; then ok "installed"
  else
    todo "Apple's install dialog opens now. Click Install, then wait (about 5 minutes)."
    if [ "$DRY" = 0 ]; then
      xcode-select --install >/dev/null 2>&1 || true
      local waited=0
      until xcode-select -p >/dev/null 2>&1; do
        sleep 5; waited=$((waited + 5))
        [ "$waited" -ge 1800 ] && die "the developer tools are still not installed. Run 'xcode-select --install', then run this installer again."
      done
      ok "installed"
    fi
  fi

  # --- 2. Node 18+ -------------------------------------------------------------
  say "2/8 Node 18 or newer"
  local NODE=""
  node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; }
  for n in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    if [ -n "$n" ] && node_ok "$n"; then NODE="$n"; break; fi
  done
  if [ -n "$NODE" ]; then ok "Node $("$NODE" -v) at $NODE"
  else
    local BREW=""
    for b in "$(command -v brew || true)" /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -n "$b" ] && [ -x "$b" ] && { BREW="$b"; break; }; done
    if [ -z "$BREW" ]; then
      todo "Homebrew installs first. It asks for your Mac password once."
      if [ "$DRY" = 0 ]; then
        [ -n "$TTY" ] || die "Homebrew needs a terminal for your password. Run this installer in Terminal."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" <"$TTY"
        for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && { BREW="$b"; break; }; done
        [ -n "$BREW" ] || die "Homebrew did not install. See https://brew.sh, then run this installer again."
      else BREW=brew; fi
    fi
    run "$BREW" install node
    if [ "$DRY" = 0 ]; then
      for n in "$(dirname "$BREW")/node" /opt/homebrew/bin/node /usr/local/bin/node; do node_ok "$n" && { NODE="$n"; break; }; done
      [ -n "$NODE" ] || die "Node did not install. Run 'brew install node', then run this installer again."
      ok "Node $("$NODE" -v) at $NODE"
    fi
  fi
  [ -n "$NODE" ] && export PATH="$(dirname "$NODE"):$PATH"

  # --- 3. Claude Code ----------------------------------------------------------
  say "3/8 Claude Code"
  local CLAUDE=""
  for c in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude "$(command -v claude || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && { CLAUDE="$c"; break; }
  done
  if [ -n "$CLAUDE" ]; then ok "installed at $CLAUDE"
  else
    todo "installing Claude Code with Anthropic's installer"
    if [ "$DRY" = 0 ]; then
      curl -fsSL https://claude.ai/install.sh | bash
      CLAUDE="$HOME/.local/bin/claude"
      [ -x "$CLAUDE" ] || die "Claude Code did not install. See https://claude.com/claude-code, then run this installer again."
      ok "installed at $CLAUDE"
    fi
  fi
  [ -n "$CLAUDE" ] && export PATH="$(dirname "$CLAUDE"):$PATH"
  # So `claude` also works in a new Terminal window.
  if [ "$CLAUDE" = "$HOME/.local/bin/claude" ] && ! grep -qs '.local/bin' "$HOME/.zshrc"; then
    run sh -c "printf '\\n# Claude Code\\nexport PATH=\"\$HOME/.local/bin:\$PATH\"\\n' >> \"\$HOME/.zshrc\""
    [ "$DRY" = 1 ] || ok "added ~/.local/bin to your PATH in ~/.zshrc (new Terminal windows)"
  fi

  # --- 4. claude.ai login --------------------------------------------------------
  say "4/8 claude.ai login"
  auth_field() { env -u ANTHROPIC_API_KEY "$CLAUDE" auth status 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j[process.argv[1]]===undefined?"":j[process.argv[1]])}catch{console.log("")}})' "$1"; }
  if [ -n "$CLAUDE" ] && [ -n "$NODE" ] && [ "$(auth_field loggedIn)" = true ] && [ "$(auth_field authMethod)" = claude.ai ]; then
    ok "logged in$(e=$(auth_field email); [ -n "$e" ] && echo " as $e")"
  else
    todo "your browser opens. Log in with your claude.ai account (not an API key)."
    if [ "$DRY" = 0 ]; then
      [ -n "$TTY" ] || die "the login needs a terminal. Run '$CLAUDE auth login --claudeai', then run this installer again."
      "$CLAUDE" auth login --claudeai <"$TTY" || true
      [ "$(auth_field loggedIn)" = true ] || die "not logged in. Run '$CLAUDE auth login --claudeai', then run this installer again."
      ok "logged in"
    fi
  fi

  # --- 5. Obsidian (optional) -------------------------------------------------------
  say "5/8 Obsidian (optional: the graph view)"
  if [ -d /Applications/Obsidian.app ] || [ -d "$HOME/Applications/Obsidian.app" ]; then ok "installed"
  else
    local want="${SECOND_BRAIN_OBSIDIAN:-}"
    if [ -z "$want" ] && [ -n "$TTY" ] && [ "$DRY" = 0 ]; then
      printf '  Install Obsidian? [Y/n] '; read -r want <"$TTY" || want=""
      case "$want" in [nN]*) want=no ;; *) want=yes ;; esac
    fi
    if [ "$want" = yes ]; then
      local BREW=""
      for b in "$(command -v brew || true)" /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -n "$b" ] && [ -x "$b" ] && { BREW="$b"; break; }; done
      if [ -n "$BREW" ]; then run "$BREW" install --cask obsidian; [ "$DRY" = 1 ] || ok "installed"
      else todo "no Homebrew: download Obsidian from https://obsidian.md, then run this installer again to add the vault to it"; fi
    else todo "skipped. Install it later from https://obsidian.md and run this installer again."; fi
  fi

  # --- 6. The kit ------------------------------------------------------------------
  say "6/8 The kit ($KIT)"
  if [ -d "$KIT/.git" ]; then
    run git -C "$KIT" pull --ff-only --quiet
    [ "$DRY" = 1 ] || ok "up to date"
  elif [ -e "$KIT" ]; then
    die "$KIT exists and is not a git clone of the kit. Move it, or set SECOND_BRAIN_DIR to another folder."
  else
    run git clone --quiet --branch "$BRANCH" "$REPO" "$KIT"
    [ "$DRY" = 1 ] || ok "cloned"
  fi

  # --- 7. Setup --------------------------------------------------------------------
  say "7/8 Setup (vault: $VAULT)"
  local SETUP=("$KIT/app/bin/second-brain" setup --vault "$VAULT" ${PASS[@]+"${PASS[@]}"})
  if [ -n "$TTY" ]; then run "${SETUP[@]}" <"$TTY"; else run "${SETUP[@]}" --yes; fi

  # --- 8. Open the app ---------------------------------------------------------------
  # The launcher starts the server when the login item has not, then opens the app.
  say "8/8 The Setup page"
  local PORT=19300
  [ -f "$STATE/settings.json" ] && [ -n "$NODE" ] && PORT=$("$NODE" -e 'try{console.log(require(process.argv[1]).port||19300)}catch{console.log(19300)}' "$STATE/settings.json")
  run "$KIT/app/bin/second-brain"

  say "Done. Two things are left, both on the Setup page:"
  printf '  1. In claude.ai → Settings → Connectors, connect Slack, Linear, Notion,\n     Google Calendar and Google Drive. Step 1 of the Setup page tests them.\n'
  printf '  2. Follow the steps to the first run and the wiki shape (about 15 minutes).\n'
  printf '\n  The app: http://localhost:%s\n  Open it again any time: the Second Brain icon in your Dock\n  (or ~/Applications/Second Brain.app, or %s)\n' "$PORT" "$KIT/app/bin/second-brain"
}

main "$@"
