---
id: usage-share
title: A daily usage share for the bots
kind: feature
commits: [28f0661]
files: [app/lib/usage.js, app/lib/exclusions.js]
principles: [config-not-hardcode, bots-through-claude-call]
---
The bots use your claude.ai plan. Each day they may use only a set share of
it; then they wait until tomorrow, unless you press Run anyway. Today shows
how much they used. A source that drops more items than usual raises an
alert.
