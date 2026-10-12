# `wiki/` — the LLM-maintained synthesis layer

**This is the only mutable layer.** `ingest` folds raw deltas (from `projects/`,
`slack/`, `linear/`, `notion/`) into synthesized, cross-linked pages here.

**Structure:** one folder per entity type in your taxonomy (`config.yaml` →
`wiki.sections`). The defaults are tuned for a partnerships / SA function — swap
them for what matters in yours (see SETUP.md, "Make it yours").

- `index.md` — catalog of every page, grouped by section.
- `log.md` — append-only record of every sync / ingest / lint run. The `ingest`
  op reads the watermark from `.last-ingest`, not from this log.
- `principles/` — your work-style canon. Ships with a couple of TEMPLATE pages
  (a worked example of an outbound-voice gate). Overwrite them with your own.

**Rules:**
- Wiki pages use `type: wiki` frontmatter (never a memory type).
- Every page ends with a `## Sources` section listing the raw files it synthesizes.
- Links are `[[wikilinks]]` everywhere so the graph builds edges.
- Contents (except READMEs + `principles/`) are `.gitignore`d by default — your
  synthesis of private data is private. Opt in via a separate private repo if you
  want to version it.
