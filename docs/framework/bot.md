# Recipe: a bot

A bot is a job the app runs: from its button, from `second-brain run <id>`,
or as a step of the Morning run. Examples: `lint` (a script, no tokens),
`brief` (a model call that writes `Brief.md`).

## Rules it touches
- `bots-through-claude-call`: every `claude -p` goes through
  `app/lib/claude-call.js` (`claudeCall(ctx, opts)`). Never build a flag list.
- `model-presses-code-writes`: the model returns text or blocks; your code
  writes files. A bot that writes raw is a sync and must follow `raw-purity`.
- `one-driver`: a bot runs inside the app only, recorded as a run.
- `config-not-hardcode`: budgets, schedules and scopes come from `config.yaml`.

## Files
1. **`app/lib/<name>-bot.js`**: one exported function
   `run<Name>(run, { claudeBin, vault, env, logLine, finish }, body)`.
   - `logLine(run, text)` for each step the owner should see.
   - End with exactly one `finish(run, status, summary, detail, costUsd)`;
     status is `ok`, `warn` or `error`. Code decides the status, not the model.
   - Model calls: `claudeCall({ claudeBin, vault, env }, { prompt, model, tools,
     allowed, budget })`. Default tools are Read, Glob, Grep. Add `mcp: true`
     only when it needs claude.ai connectors (they cost tokens on every turn).
2. **`app/lib/brain.js`**, the `BOTS` list: an entry
   `{ id, name, kind: 'model' | 'bash', blurb, run: (run, claudeBin, body) => ... }`.
   The blurb is what the board shows: say what it does and what it costs.
3. **`app/public/brain.js`**, `GROUPS`: add the id to the group it belongs to,
   or it does not show in the nav.
4. **Morning run** (only if it runs daily): `app/lib/schedule.js`,
   `runMorning()`. Say in the plan why it must be daily and what it costs.
5. **Config** (only if it has settings): a key in `config.example.yaml` with a
   default and a comment (`config-not-hardcode`).

## Tests (`app/test/<name>-bot.test.js`)
- The parts that are pure code (parsing, deciding the status, what it writes)
  as unit tests, with a temp vault from `fs.mkdtempSync`.
- If it calls claude: a fake claude, as `app/test/fake/` and
  `app/test/e2e-sessions.test.js` do. Tests never call the real model.
- `app/test/claude-call.test.js` already fails if the bot builds its own
  claude flags.

## Done when
`bash tests/run.sh` passes, the bot shows on the board with a true blurb, and
one run from its button ends `ok` in a test vault.
