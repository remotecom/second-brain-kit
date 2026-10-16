# Recipe: a source

A source is a place the app syncs raw from, into its own vault folder.
Examples: `slack` (one file per day), `gdrive` (one file per item). Gmail is
specified but has no sync yet; it shows what a source looks like before it
works.

## Rules it touches
- `raw-immutable` and `raw-purity`: the sync writes only its own folder,
  verbatim. No summaries, no `[[wiki links]]`, no "relevant" filtering.
- `model-presses-code-writes`: the model only calls the connector's tools.
  Your code reads the tool results, renders the files and writes them.
- `bots-through-claude-call`: the button presses go through `app/lib/buttons.js`
  (`collect()` or `pressButtons()`), which use `claudeCall`.
- `ingest-contract`: the new folder must show in the `Deltas walked:` line.
- `config-not-hardcode`: the window, scope and exclusions come from `config.yaml`.
- `think-before-design-change`: a new source is a new data flow and a new
  daily cost. Agree the design with the owner first.

## Files
1. **`app/lib/<key>-mcp.js`**: one exported `sync<Key>Mcp(run, ctx)`. Copy
   `app/lib/gcal-mcp.js` (short) or `app/lib/slack-mcp.js` (paged, threads).
   - Tool names: `tool(vault, '<key>', '<tool>')` from `app/lib/connectors.js`.
   - Range: from the window and `<dir>/.last-sync` (`rangeFor()` in
     `app/lib/sync.js`, or the gcal form with `bootstrap_days`).
   - Exclusions: apply them at fetch time, count each kind, and say the counts
     in the summary. Report hits with `require('./exclusions').report()`.
   - Then, in this order: `verify()` (the gate; on a problem, `finish` with
     `error` and write nothing), `commit()` (hash skip and raw ledger), and
     only then write `<dir>/.last-sync`.
2. **`app/lib/sync.js`**, `SOURCES`: `{ name, dir, dayFiles }`. The key must
   equal the folder name: Ingest holds a failed source by `sync-<key>` → `<key>/`.
3. **`app/lib/brain.js`**, `BUTTON_SYNCS`: map the key to your function. The
   `sync-<key>` bot is then made from `SOURCES`.
4. **`app/lib/connectors.js`**: `NAMES`, `REQUIRED` (Setup finds the prefix by
   it), `HEALTH_CALLS` (one cheap read) and `WRITE_TOOLS` (every tool that
   sends, saves or deletes; bots deny them by name).
5. **Raw class:** `scripts/raw-classes.sh` (`RAW_CLASSES`, `RAW_SUBPATHS`).
   Remove it from `RAW_UNIMPLEMENTED` in the same change that lands the sync.
6. **Lists that name every source:** `SYNC_ORDER` in `app/lib/schedule.js`,
   `GROUPS` (`g-syncs`) in `app/public/brain.js`, `RAW_DIRS` in
   `app/lib/doctor.js`, `RAW` in `app/lib/sessions/index.js` (deny rules),
   `ORDER` in `app/lib/ingest.js`, and the raw folder list in `PRINCIPLES.md`
   (`raw-immutable`, its own commit).
7. **Templates:** `templates/vault/<dir>/README.md`; a `## Sync (<Name>)`
   section in `templates/vault/OPS.md` (it becomes `.bot/ops.md`); the folder
   in the Layout and Rules of `templates/vault/CLAUDE.md`. A new
   `{{<KEY>_WINDOW}}` needs a line in `values()` in `app/lib/kit-block.js`.
8. **Config:** `connectors.<key>` and `sources.<key>` (`enabled`,
   `window_days`) in `config.example.yaml`. See [config-key.md](config-key.md).

## Tests
- `app/test/renderers.test.js`: the parse and render functions, with sample
  tool results made up from generic names.
- The gate: a missing day file, or a file outside `<dir>/`, writes nothing
  and leaves `.last-sync` alone.
- `tests/run.sh` section 4 reads `RAW_SUBPATHS`, so it checks that the new
  class reports a number. A flat folder (no subfolders) must also join the
  `projects|slack|gcal` case in that loop, or the check looks for the wrong label.

## Done when
`bash tests/run.sh` passes, a run from the `sync-<key>` button ends `ok` in a
test vault, `Deltas walked:` shows `<dir>=N`, and with the connector off the
run ends `error` with the claude.ai connectors fix (never `ok` with 0 files).
