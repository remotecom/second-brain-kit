---
id: one-line-installer
title: A one-line installer
kind: feature
commits: [2339f41, 9adc460, c904784]
files: [install.sh, app/lib/setup.js]
principles: [side-install-stays-side]
---
One command installs what is missing (Node, Claude Code, the kit, and
Obsidian if you want it) and opens the Setup page. Setup adds your vault to
Obsidian's vault list, so Open in Obsidian works on a new Mac.
