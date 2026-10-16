---
id: session-save-close
title: Save & close copies a session to raw, and sessions can be renamed and reordered
kind: feature
commits: [08b28b8]
files: [app/lib/session-raw.js, app/lib/sessions/index.js, app/public/brain.js, app/lib/retention.js]
principles: [raw-immutable, ingest-contract]
---
Save & close writes the session's text, word for word and with credentials
removed, to projects/sessions/ in your vault. The next Ingest reads it like
any other raw file. You can rename a session (double-click) and drag it to a
new place in the list. Memories are kept on every Mac.
