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
| Source | a new place to sync raw from (Slack, Linear, ...) | [source.md](source.md) |
| Session kind | a new kind of guided Claude session in the panel | [session-kind.md](session-kind.md) |
| Config key | a new setting in `config.yaml` | [config-key.md](config-key.md) |

Every recipe ends the same way: `bash tests/run.sh` passes, the change is
committed, and the owner presses Apply.
