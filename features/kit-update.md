---
id: kit-update
title: second-brain update and the Today update card
kind: feature
commits: [98f698b]
files: [app/cli.js, app/lib/brain.js]
principles: [config-not-hardcode]
---
The app checks for a new version of the kit a few times a day and shows it on
Today. Update pulls it, adds new config keys without changing yours, and
restarts the app.
