---
id: session-panel-newline
title: Shift+Enter makes a new line in the session panel
kind: feature
commits: [96c950d]
files: [app/public/session.js, app/lib/kit-block.js]
principles: [plain-words]
---
In the session panel, Shift+Enter starts a new line and Enter sends. The kit
block in your vault's CLAUDE.md is also kept under 40k characters, so every
session loads it fast.
