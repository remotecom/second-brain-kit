---
id: make-me-better
title: Make me better changes your own copy of the app
kind: feature
commits: [656fc3a]
files: [PRINCIPLES.md, app/lib/improve.js, app/lib/apply.js, app/lib/apply-runner.js, app/lib/kit-git.js]
principles: [apply-is-the-gate, model-presses-code-writes, tests-are-not-negotiable, think-before-design-change]
---
The ✦ Make me better button opens a Claude session on your own copy of the
app. The session reads the kit's rules, objects by rule id to a change that
breaks one, and builds the change in a dev copy. Apply runs the tests and a
trial start, then switches the app. If the app does not come back, it rolls
back by itself. Undo last Apply goes back one step.
