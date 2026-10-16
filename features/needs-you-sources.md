---
id: needs-you-sources
title: Each contradiction in Needs-You shows its sources
kind: feature
commits: [81dca7f]
files: [app/lib/claim-sources.js, app/lib/resolve-bot.js]
principles: [one-driver, raw-immutable]
---
When Verify finds two wiki claims that disagree, Needs-You now shows the raw
files behind each claim. Code checks the sources, not the model. You pick the
claim that is true, and Resolve edits the pages.
