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

## Upstream fixes on Needs-You (Make me better, Phase 3)
- **What:** when an upstream feature note is `kind: fix` or `kind: security` and a copy with its own commits has not brought it in, add one Needs-You item for it.
- **Why:** with the "menu" model (a changed copy brings in only the upstream features its owner picks), fixes reach that copy only if picked. This is the nudge.
- **Pros:** security fixes do not go unseen; reuses Needs-You, which people already check.
- **Cons:** Verify owns `Needs-You.md`. A second writer can race it, so Verify should call `features.whatsNew()` itself and write the items.
- **Context:** the Make me better design (Phase 3). Phase 2 shipped What's new as code (`app/lib/features.js`, `whatsNew(kitDir)`: items with `kind` and `status`); it reads what the update check fetched, so Verify can call it with no fetch and no ledger. Start where `verify-bot.js` writes Needs-You.
- **Depends on:** Phase 2 (done: `features/` notes, What's new, Bring this in). Added 2026-10-15 (eng review).
