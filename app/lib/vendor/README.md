# Vendored libraries

Copied in so the app needs no `npm install`. Do not edit these files; replace
them with a newer release and update this table.

| File | Library | Version | Source | sha256 | License |
|---|---|---|---|---|---|
| `js-yaml.js` | js-yaml | 4.1.0 | `https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.js` | `c738b0020702aa631abd8de23a902a3079d99d3060e44166955cb51f570881c4` | MIT (`js-yaml.LICENSE`) |
| `ws/` | ws | 8.21.3 | npm `ws@8.21.3` (copied from a working install; `index.js`, `lib/`) | (directory) | MIT (`ws/LICENSE`) |

Browser side (`app/public/vendor/xterm/`):

| File | Library | Source | sha256 (xterm.js) | License |
|---|---|---|---|---|
| `xterm.js`, `xterm.css`, `xterm-addon-fit.js`, `xterm-addon-web-links.js` | xterm.js 5.x | the build vendored in briefcase@070851e (`public/lib/xterm/`) | `14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972` | MIT (`LICENSE`) |

The unicode11 add-on is left out on purpose: one line it cannot measure hangs
`term.write` with no error (measured in Briefcase).
