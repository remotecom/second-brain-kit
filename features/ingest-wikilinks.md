---
id: ingest-wikilinks
title: Ingest writes wiki links that resolve
kind: fix
commits: [74211f0]
files: [app/lib/ingest.js]
principles: [ingest-contract]
---
Ingest wrote some links as [[page.md]], which Obsidian does not resolve. It
now writes [[page]].
