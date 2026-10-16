# Framework: how to add to the kit

The kit grows by recipes. Each recipe is one kind of change, with the files
it touches, the rules it must keep (ids from `PRINCIPLES.md`) and the tests
it needs. A Make me better session picks the recipe that fits a request
before it builds anything. When nothing fits, it says so, and the change is
designed first (`think-before-design-change`).

| Recipe | Use it for | File |
|---|---|---|
| Bot | a job the app runs on a button or on the Morning schedule | [bot.md](bot.md) |
| Page | a new screen or panel in the app window | [page.md](page.md) |
| Source | a new place to sync raw from (Slack, Linear, ...) | planned (Phase 2) |
| Session kind | a new kind of guided Claude session in the panel | planned (Phase 2) |
| Config key | a new setting in `config.yaml` | planned (Phase 2) |

Until a planned recipe exists, follow the closest existing example in the
code and name it in the plan (for a source, `app/lib/slack-mcp.js`; for a
session kind, `sessionSpec()` in `app/lib/brain.js`; for a config key, the
`config-not-hardcode` rule and `app/test/config.test.js`).

Every recipe ends the same way: `bash tests/run.sh` passes, the change is
committed, and the owner presses Apply.
