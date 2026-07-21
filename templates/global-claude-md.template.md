# Second Brain Kit — global memory block

Paste this into your **`~/.claude/CLAUDE.md`** (create it if it doesn't exist).
It shapes how Claude's auto-memory writes memories so `ingest` can consume them
consistently. This is the personalization layer — the part that makes the vault
learn how *you* work.

---

## Memory discipline

Persist durable facts to file-based memory. Each memory is one file, one fact,
with frontmatter:

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary — used for recall relevance>
metadata:
  type: user | feedback | project | reference
  wiki_ingest: true            # set false for operational/state-only memories
---

<the fact. For feedback/project, add **Why:** and **How to apply:** lines.
Link related memories with [[their-name]].>
```

- **`user`** — who I am (role, expertise, preferences).
- **`feedback`** — guidance on how you should work (corrections + confirmed
  approaches); always include the why.
- **`project`** — ongoing work, goals, constraints not derivable from the repo.
  Convert relative dates to absolute.
- **`reference`** — pointers to external resources (URLs, dashboards, tickets).

**Save triggers:** when I correct you, state a durable preference, lock a
decision, or explain something non-obvious you'll need again — write it down.
Check for an existing file that covers it first; update rather than duplicate.
Don't save what the repo/git already records.

**`wiki_ingest: false`** — mark operational state (resume markers, watermarks,
env setup) so the vault's `ingest` skips it.

## Outbound comms (the review gate)

Never post to a channel/partner/doc directly. Draft it, deliver it to me for
review, I send it myself. Follow the voice rules in my vault's
`wiki/principles/outbound-voice.md`.
