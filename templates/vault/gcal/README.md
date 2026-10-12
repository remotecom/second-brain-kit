# `gcal/` — raw, immutable (Google Calendar forward-sync)

**What lives here:** `YYYY-MM-DD.md` daily files written by `sync gcal`. Events
are day-scoped, so the Slack-style daily file fits; overwriting in-window is what
self-heals reschedules and cancellations.

**Rules:**
- **Raw and immutable.** Never hand-edit. Every recurring instance is recorded
  verbatim — filtering repeats is `ingest`'s job, never sync's.
- `gcal/.last-sync` — watermark (most recent event `updated`).
- `eventType: ['DEFAULT']` is passed explicitly. The connector's default also
  returns `FOCUS_TIME`, `OUT_OF_OFFICE` and `FROM_GMAIL`, which would fill the
  vault with focus blocks.
- Events with `visibility: private` are skipped unless `include_private: true`.
- Attendees carry `email`, `displayName`, `responseStatus` and `organizer` —
  this is the relationship graph that `wiki/people/` is built from.
- Drive links in `attachments[].fileUrl` cross-link to `gdrive/files/<id>`,
  joining a meeting to the document it produced.

**Known limit (connector, not choice):** `list_events` filters on *event* time,
not modification time, and exposes no `updatedMin`. An event edited today for a
meeting last month will not appear in a rolling window over event time. Resolve
before relying on this as a change feed.

This folder is `.gitignore`d — your calendar is private.
