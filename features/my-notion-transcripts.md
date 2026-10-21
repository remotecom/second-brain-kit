---
id: my-notion-transcripts
title: Notion meeting notes sync with their transcript
kind: feature
commits: []
files: [app/lib/notion-mcp.js, config.example.yaml, app/lib/config.js, templates/vault/OPS.md]
principles: [raw-purity, config-not-hardcode, model-presses-code-writes]
---
Notion meeting-note pages now sync with the full transcript, not only the AI
summary, so ingest can cite what was said. Secrets in a transcript are
replaced, a transcript over max_transcript_chars is cut with a marker, and
pages or databases in exclude_transcripts_for keep Notion's placeholder. Old
meeting pages are fetched again, 10 per sync, until none are missing their
transcript. Turn it off with sources.notion.include_meeting_transcripts.
