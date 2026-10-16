---
id: ingest-deletes-own-transcripts
title: Ingest deletes its own transcripts
kind: feature
commits: [29e0309]
files: [app/lib/bot-transcripts.js, app/lib/ingest.js]
principles: [raw-immutable]
---
Each Ingest part runs as a Claude call, and Claude Code keeps a transcript of
every call. When a part passes, Ingest now deletes the transcripts of its own
calls. Your own sessions and memories are never touched.
