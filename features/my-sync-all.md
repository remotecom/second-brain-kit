---
id: my-sync-all
title: Sync All runs every sync in one click
kind: feature
commits: [ab7718c]
files: [app/bots/sync-all.js, app/lib/schedule.js, app/lib/brain.js]
principles: [one-driver, config-not-hardcode]
---
The Syncs group has a new first row, All. Its Run button starts every sync
that is turned on in config.yaml, one after the other, in the Morning run's
order. Each sync keeps its own run and log. It costs the same as pressing
each sync yourself, and it does not ingest.
