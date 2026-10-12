# TODOS

## API-key auth mode for bots
- **What:** let bots run on `ANTHROPIC_API_KEY` instead of a claude.ai login.
- **Why:** a teammate without a claude.ai seat can't run the app today; with an API key the dollar budget becomes real money.
- **Pros:** wider audience; exact cost control.
- **Cons:** the bots reach Slack/Linear/Notion/Google through claude.ai connectors, which exist only under a claude.ai login. API-key mode needs local MCP servers for all five sources, and headless `claude -p` did not expose plugin MCP tools when measured on 2026-10-01.
- **Context:** `claudeEnv()` in `app/lib/brain.js` deletes `ANTHROPIC_API_KEY` on purpose. Start by re-testing whether headless runs expose `--mcp-config` servers with an API key, one source first (Linear has an official remote MCP).
- **Depends on:** nothing; independent of onboarding. Added 2026-10-05 (eng review OV2).

## App MCP server
- **What:** an MCP server inside the app with `status`, `whats_waiting`, `run_bot`, `answer_needs_you`.
- **Why:** Claude Code / Cowork sessions could ask "what's waiting on me?" or "sync Linear" and go through the app instead of running ops themselves (the two-drivers collision).
- **Pros:** one driver for writes; chat becomes a remote control for the app.
- **Cons:** another surface to keep in sync with the HTTP API; needs registering per runtime.
- **Context:** the onboarding plan's `.bot/lock` (OV3) and `doctor()` (12A) are the foundations. Back-pocket item from 2026-10-05; the app works without it.
- **Depends on:** onboarding plan phases 0-1.

## Gmail sync
- **What:** `sync gmail`, thread-per-file raw under `gmail/threads/`.
- **Why:** email is the one human-written source not synced.
- **Blocked:** the Gmail connector has no mail scopes (`Insufficient scope`), and the op is unwritten. Design already decided in `gmail/README.md`.
- **Must ship with:** raising the `people/` external-DRI promotion threshold from 1 thread to 2, in the same change, or the first ingest floods `wiki/people/`.
- **Depends on:** connector re-auth with mail scopes.
