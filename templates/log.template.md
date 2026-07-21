# Vault log

Append-only chronological record of every `sync`, `ingest`, and `lint` run.
`ingest` reads the watermark from `wiki/.last-ingest`, NOT from these headers —
headers are display-only labels.

> Copy this file to `wiki/log.md` on first setup.

## [YYYY-MM-DD HH:MM] init | fresh vault created from the Second Brain Kit
Nothing synced yet. First run: `sync` → `ingest` → `query`.
