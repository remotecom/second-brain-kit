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

# Derived renderings.
RAW_DIRS="$RAW_CLASSES"
RAW_ALT=$(printf '%s' "$RAW_CLASSES" | tr ' ' '|')
