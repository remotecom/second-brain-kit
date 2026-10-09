# `wiki/principles/` — your work-style canon

Universal, cross-project rules for how you want the assistant to operate — the
layer that makes the vault feel tuned to *you* rather than generic.

This folder starts **empty except this README**. The kit ships example
principles under `templates/principles/` (a worked outbound-voice gate in
someone else's voice). Copy what's useful, then rewrite in your own voice:

```bash
cp templates/principles/outbound-voice.example.md wiki/principles/outbound-voice.md
# then edit it to encode YOUR rules
```

Your filled-in principles are `.gitignore`d by default (they can reference
partner/customer specifics). Keep them; they compound.

The one rule most people keep verbatim: **never post outbound comms directly —
draft first, review, then send yourself.** See `config.yaml` → `outbound_gate`.
