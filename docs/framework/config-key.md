# Recipe: a config key

A config key is one setting in the vault's `config.yaml`. The kit's
`config.example.yaml` is the schema: every key, its default and a comment.
Examples: `schedule.morning_at`, `sources.gcal.max_description_chars`.

## Rules it touches
- `config-not-hardcode`: a value that differs per person or company is a key,
  never a constant in the code.
- Migration only adds keys. It never changes or removes a value the owner set.
  `migrateConfig()` proves this with `assertKept()` and throws if it fails.
- Old code ignores a key it does not know. `getConfig()` merges the file over
  the defaults, so an extra key is harmless. `validate()` warns about an
  unknown top-level key ("a typo?") but the bots still run.
- `no-private-names`: the default and the comment use generic values
  (acme, jane.doe@example.com).

## Files
1. **`config.example.yaml`**: the key in the block it belongs to, with a
   working default and a comment that says what it does, in plain words.
   `defaults()` in `app/lib/config.js` reads this file, so the key now has
   its default everywhere.
   - A person-specific value (a name, an ID, an email) is a placeholder. Blank
     it in `defaults()`, as `owner` and `sources.gcal.calendars` are.
   - A map whose keys are the owner's own (as `wiki.section_notes`) goes in
     `OWNED_MAPS`, so migration never fills it from the defaults.
2. **The code that uses it:** `getConfig(vault).<path>`. Never read
   `config.yaml` by hand. A list that can be written empty (`key:` with
   nothing under it) needs a `null` to `[]` line in `getConfig()`, as
   `ingest.exclude` has (lists under `sources.*` get it already).
3. **`validate()` in `app/lib/config.js`**: a check for a bad value, with
   `add('error' | 'warn', '<dotted.key>', '<plain message>')`. Error means a
   bot cannot run. `check()` in `app/lib/doctor.js` turns each finding into a
   doctor item; a `sources.<key>` finding blocks `sync-<key>` only.
4. **Moved or renamed key** (only then): read the old place in
   `normalizeLegacy()` and move the text in `convertLegacy()`. Never drop the
   old value.
5. **CLAUDE.md** (only if a spec shows it): a `{{PLACEHOLDER}}` in
   `templates/vault/CLAUDE.md` or `OPS.md`, and its line in `values()` in
   `app/lib/kit-block.js`. `render()` throws on an unknown placeholder.
6. **Setup page** (only if the owner sets it there): `app/lib/setup.js`
   writes with `writeValues()`, as text, so comments stay.

Existing vaults get the key on the next `update` or Apply: both run
`cli.js update --post --write`, and `postUpdate()` calls `migrateConfig()`.

## Tests (`app/test/config.test.js`)
- "every key in config.example.yaml round-trips through getConfig" covers
  the new key by itself. Run it.
- `migrateConfig` on a file without the key: the key is added with its
  default, an owner value next to it is unchanged, and a second run adds nothing.
- Each `validate()` check: one bad value gives the finding with its key.

## Done when
`bash tests/run.sh` passes, a vault without the key gets it from
`second-brain update --post --write` with no other line changed, and the
code reads the value from `getConfig()`.
