# Second Brain Kit (the code)

This repo is the tool: the kit scripts, the vault template and the Second Brain
app. It is **public**. Each person's vault (raw sources, wiki, `config.yaml`,
`.bot/`) lives in a separate folder and never enters this repo.

## Layout

- `app/` — the Second Brain app (Node, no npm step). `server.js`, `lib/` (bots,
  config, doctor, time, connectors), `public/` (the control room),
  `bot-settings.json` (settings for unattended bots), `bin/second-brain`.
- `app/lib/vendor/` — vendored libraries (see its README). Do not edit them.
- `scripts/` — the scripts every vault runs: `delta-walk.sh`,
  `linkrot-lint.sh`, `bind-project-memory.sh`, `raw-classes.sh`. Each takes
  `--vault <dir>`.
- `templates/vault/CLAUDE.md` — the kit block the app writes into a vault's
  `CLAUDE.md` (between `kit:begin` / `kit:end`). Placeholders come from the
  vault's `config.yaml`.
- `templates/` — other starter files (wiki index and log, page template).
- `config.example.yaml` — the config schema: every key, its default, why.
- `tests/run.sh` — the whole test suite (bash checks + `node --test app/test`).

## Rules for changes

- **No private names in anything committed.** No partner, customer, internal
  channel or person names, not even in comments or examples. Use generic ones
  (acme, globex, jane.doe@example.com). `tests/run.sh` section 6 checks every
  committable file against a denylist kept outside the repo.
- **Values that differ per person or company come from `config.yaml`.** Add a
  key to `config.example.yaml` with a default and a comment; never hardcode.
- **The model presses buttons; code writes raw.** Bots never write raw files,
  watermarks or ticks themselves.
- **Every unattended `claude -p` call goes through `app/lib/claude-call.js`.**
- Run `bash tests/run.sh` before every commit.
