---
id: wiki-shape
title: Wiki shape, the first-ingest setup step
kind: feature
commits: [0c8a1d8, 97b2bca, 776dc20]
files: [app/lib/wiki-shape.js, app/lib/setup.js, app/lib/config.js]
principles: [config-not-hardcode, ingest-contract]
---
Before the first Ingest, you pick the folders your wiki has (partners,
systems, people, and so on), from a preset or from a suggestion built from
your own data. Apply sets up the index headings and removes empty default
folders. A folder may not take a raw source folder's name.
