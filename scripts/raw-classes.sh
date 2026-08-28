#!/usr/bin/env bash
# raw-classes.sh — the single source of truth for "what counts as a raw layer".
# Sourced by linkrot-lint.sh and delta-walk.sh. ADD A NEW SOURCE HERE ONLY.
#
# Two levels exist because they answer different questions:
#   RAW_CLASSES  top-level layers          — used for [[link]] matching + grep -r
#   RAW_SUBPATHS the countable directories — used for the ingest delta walk,
#                because linear/ and notion/ fan out into resource subdirs and
#                the `Deltas walked:` line must name each one separately.

RAW_CLASSES="projects slack linear notion gdrive gmail gcal"

RAW_SUBPATHS="projects slack linear/issues linear/projects linear/initiatives linear/docs notion/pages notion/databases gdrive/files gmail/threads gcal"

# Classes carried in the lists above but with NO implemented sync op.
# Reported as SKIPPED-not-implemented, never as 0.
#
# WHY a scaffolded class is carried at all: dropping it from RAW_SUBPATHS would
# make the `Deltas walked:` line omit it entirely, and an ABSENT class is
# precisely the silent-skip footprint that line exists to catch. But reporting
# it as `0` is just as bad in the other direction — `gmail/threads=0` is
# indistinguishable from a working source with an empty delta, so a permanently
# dead source reads as a healthy one. SKIPPED is the only honest third state.
#
# Remove an entry here in the SAME change that lands its sync op — never before
# (the op would report 0 while doing nothing) and never after (a working source
# would keep reporting SKIPPED and its deltas would go uningested).
RAW_UNIMPLEMENTED="gmail/threads"

# Derived renderings.
RAW_DIRS="$RAW_CLASSES"
RAW_ALT=$(printf '%s' "$RAW_CLASSES" | tr ' ' '|')
