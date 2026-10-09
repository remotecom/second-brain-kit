# `slack/` — raw, immutable (Slack forward-sync)

**What lives here:** one `YYYY-MM-DD.md` per day, written by `sync slack`. Your
sent messages + mentions, with full threads expanded.

**Rules:**
- **Raw and immutable.** Never hand-edit. Days inside the rolling window are
  overwritten on every sync (that overwrite is the self-healing mechanism for
  late thread replies — there is intentionally no content-hash skip for Slack).
- `slack/.last-sync` is the watermark (most recent message `ts` synced).

This folder is `.gitignore`d — your Slack content is private.
