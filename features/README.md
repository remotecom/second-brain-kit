# Feature notes

One note per change a user can see. The What's new page reads these notes:
in your copy, it shows the upstream notes you do not have yet, and Bring
this in ports one with a Claude session.

```yaml
---
id: session-save-close          # the file name without .md
title: Save & close copies a session to raw
kind: feature                   # feature | fix | security
commits: [08b28b8]              # earlier commits; the commit that adds the note counts too
files: [app/lib/session-raw.js] # the main files (each must be in one of the commits)
principles: [raw-immutable]     # rule ids from PRINCIPLES.md
---
Two or three sentences a user can read.
```

- A note you make in your own copy (Make me better) has an id that starts
  with `my-`. Upstream notes never do.
- A ported note keeps the upstream id and adds `ported_from: <upstream sha>`
  and `variant: as-is` or `variant: customized`.
- `app/test/features.test.js` checks every note.
