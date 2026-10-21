---
id: my-apply-strip
title: Apply shows each step and says how it ended
kind: feature
commits: []
files: [app/public/session.js, app/lib/apply-progress.js, app/lib/brain.js]
principles: [apply-is-the-gate, plain-words]
---
In a Make me better session, a strip under the header shows what Apply is
doing: the step, the time so far and the newest log line. Questions and
errors show there with buttons, not in popups, and Undo and Discard use the
same strip. Apply keeps going if you reload the page. After the restart, a
banner names the features that came in, or says why the app went back.
While Apply runs, bots and the Morning run wait.
