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
1. **`app/bots/<id>.js`**: one file, one bot. The app loads every file in
   `app/bots/` at start, so you do not edit `brain.js` or the nav:

   ```js
   module.exports = {
     id: 'stale-pages', name: 'Stale pages', kind: 'bash',  // or 'model'
     group: 'g-checks',  // nav group: g-daily, g-syncs, g-wiki, g-checks; else "Other"
     blurb: 'What it does and what it costs.',
     run: async (run, { claudeBin, vault, env, logLine, finish, runBot }, body) => { ... },
   };
   ```
   - The id matches the file name. `app/lib/bot-registry.js` checks the
     fields; a file that fails is skipped, and the app logs why.
   - `logLine(run, text)` for each step the owner should see.
   - End with exactly one `finish(run, status, summary, detail, costUsd)`;
     status is `ok`, `warn` or `error`. Code decides the status, not the model.
   - Model calls: `claudeCall({ claudeBin, vault, env }, { prompt, model, tools,
     allowed, budget })` from `app/lib/claude-call.js`. Default tools are Read,
     Glob, Grep. Add `mcp: true` only when it needs claude.ai connectors (they
     cost tokens on every turn).
   - `runBot(id, body)` starts another bot as its own recorded run.
   - Put larger code in `app/lib/<name>-bot.js` and call it from the file.
2. **Morning run** (only if it runs daily): `app/lib/schedule.js`,
   `runMorning()`. Say in the plan why it must be daily and what it costs.
3. **Config** (only if it has settings): a key in `config.example.yaml` with a
   default and a comment (`config-not-hardcode`, [config-key.md](config-key.md)).
4. **A feature note**: `features/my-<id>.md` in your copy (`features/README.md`).

The built-in bots are still the `BOTS` list in `app/lib/brain.js`. Leave
them there; a new bot goes in `app/bots/`.

## Tests (`app/test/<name>-bot.test.js`)
- The parts that are pure code (parsing, deciding the status, what it writes)
  as unit tests, with a temp vault from `fs.mkdtempSync`.
- If it calls claude: a fake claude, as `app/test/fake/` and
  `app/test/e2e-sessions.test.js` do. Tests never call the real model.
- `app/test/claude-call.test.js` already fails if the bot builds its own
  claude flags (it reads `app/lib/` and `app/bots/`).
- `app/test/bot-registry.test.js` fails if a file in `app/bots/` does not load.

## Done when
`bash tests/run.sh` passes, the bot shows on the board with a true blurb, and
one run from its button ends `ok` in a test vault.
