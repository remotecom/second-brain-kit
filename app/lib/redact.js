// Secrets are replaced, never copied into the vault. This is the vault spec's
// one declared exception to verbatim raw (2026-10-01). Patterns are kept
// deliberately specific so ordinary prose about "passwords" is left alone.

const SECRET_RES = [
  /\bxox[abpors]-[A-Za-z0-9-]{10,}/g,                         // Slack tokens
  /\bsk-[A-Za-z0-9_-]{20,}/g,                                 // API keys in sk- form
  /\bAKIA[0-9A-Z]{16}\b/g,                                    // AWS access key ids
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,                            // GitHub tokens
  /https:\/\/share\.1password\.com\/\S+/g,                    // 1Password share links
  /\b(client_secret|password|passwd|api[_-]?key|secret)\b(\s*[:=]\s*|\s+is\s+)\S+/gi,
];
function redact(text, onHit) {
  let out = text;
  for (const re of SECRET_RES) out = out.replace(re, (m, k) => { onHit(); return typeof k === 'string' && /secret|password|passwd|api/i.test(k) ? `${k} [credential redacted by sync]` : '[credential redacted by sync]'; });
  return out;
}

module.exports = { redact };
