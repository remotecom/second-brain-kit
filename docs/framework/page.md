# Recipe: a page

A page is a screen in the app window: an entry in the left nav and what the
main area shows when it is picked. Examples: Today, Sessions, Setup.

## Rules it touches
- Every `/api/*` route needs the token: `app/server.js` refuses a request
  without `X-Brain-Token`, and the page's `api()` helper sends it. Never add
  an unauthenticated route that reads or changes the vault.
- `one-driver` and `raw-immutable`: a page reads; changes go through an API
  route whose code does the write, never the browser.
- `plain-words`: labels and help text are short and plain.

## Files
1. **API (if the page needs data):** `app/lib/brain.js`, `handle()`.
   - A new path prefix must be added to the first check in `handle()`
     (`if (!p.startsWith('/api/brain/') && ...) return false;`), or the route
     is never reached.
   - Return with `json(res, code, body)`; read a body with `await readBody(req)`.
   - A route that starts work longer than a second starts a run
     (`newRun`, `logLine`, `finish`) so the log drawer shows it.
2. **Nav:** `app/public/brain.js`, `paintNav()`: one `nav-item` with
   `data-sel="<id>"`.
3. **Main area:** `app/public/brain.js`, `paint()`: the line that picks the
   page by `sel` (`sel === 'today' ? todayPage() : ...`); add
   `<id>Page()` that returns HTML. Escape every value from the vault with
   `esc()`.
4. **Clicks:** the one delegated click handler in `app/public/brain.js`
   (`t.closest('[data-...]')`). Use `data-` attributes, not inline handlers.
5. **Styles:** `app/public/brain.css`, reusing the existing classes first.

## Tests
- The API route: `app/test/<name>.test.js`, with a server started as
  `app/test/setup.test.js` does (`serve()`), including one request WITHOUT
  the token that must get 401.
- Pure helpers that build the page's data: unit tests.

## Done when
`bash tests/run.sh` passes, and the page works in the window after Apply
(press Cmd+R once the app is back).
