---
id: host-check
title: The app refuses requests for other host names
kind: security
commits: [d647b37]
files: [app/server.js]
principles: []
---
The app answers only requests addressed to itself. A web page that tries to
reach the app through a different host name (DNS rebinding) is refused.
