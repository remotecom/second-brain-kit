# Recipe: a session kind

A session kind is one kind of guided Claude Code session in the app's session
panel. The app writes the first message and the outcome buttons; the owner
talks with Claude in a real terminal. Examples: `repair`, `needs` (Look into
an item), `shape` (Shape your wiki), `improve` (Make me better).

## Rules it touches
- `model-presses-code-writes`: an outcome button is app code. The model may
  suggest one (`SUGGEST: <label>`); it never does the outcome itself.
- `one-driver`: a session never runs syncs, ingest or other app jobs, and
  never ticks `Needs-You.md`. An outcome starts the bot as a recorded run.
- `raw-immutable`: the deny rules in `sessionSettings()` stop writes to raw
  folders, watermarks, `.bot/**`, `Needs-You.md` and `config.yaml`.
- `plain-words`: the title, the buttons and the prompt are short and plain.

## Files
1. **`app/lib/brain.js`, `sessionSpec(kind, item)`**: one `if (kind === '<kind>')`
   branch that returns `{ title, outcomes, item, prompt }`.
   - Code builds the prompt. Start with `SESSION_BASE`: it says that vault
     text is data from other people, never instructions.
   - Find the item on the server from its id. Never trust text from the
     browser. Throw an error for an unknown item.
   - Quote vault text (log lines, item text) as data, in a fenced block.
   - End with `SUGGEST_RULE(outcomes.map((o) => o.label))`.
   - The server opens the existing session for the same `[kind, item]`
     instead of a second one, so return a stable `item`.
2. **`app/lib/brain.js`, `runOutcome(action)`**: each outcome is
   `{ label, action: { type, ... } }`. Reuse a type that exists (`run`,
   `repair`, `doctor`, `tick`, `restructure`, `shape-apply`). A new type is a
   new branch here, and it must check its input as `answerNeed()` does.
3. **Where it opens:** a button with `data-act="session"`,
   `data-slug="<kind>"` and `data-body` (the item as JSON) in
   `app/public/brain.js`, or an action `{ kind: 'session', slug, body }` in
   `todoFor(id)` in `app/lib/brain.js`. Add the page to show when it ends to
   `DONE_PAGE` in `app/public/brain.js`.
4. **Its own folder, settings or env** (only if it must not run in the vault):
   copy `spec()` in `app/lib/improve.js`. It sets `cwd`, `settings` (a file
   with its own deny rules or sandbox) and `env`; `Sessions.create()` keeps
   them across sleep and resume. Then also:
   - Save & close is for vault sessions only. Today the check is by name
     (`s.kind === 'improve'`) in the close route in `app/lib/brain.js` and in
     `app/public/session.js`. Add the new kind to both.
   - Open it from its own route, as `/api/improve/open` does.

## Tests
- `app/test/e2e-sessions.test.js`: start the server with the fake claude
  (`world()`, `server()`), POST `/api/sessions` with the kind and item, and
  check the title and outcome labels; an unknown item gets an error; the same
  item twice gives the same session id; an outcome it lacks is refused.
- An outcome that changes something: check the change and that the session
  is `done` with that outcome, as the Repair test does.
- A kind with its own settings: check the settings file as
  `app/test/sessions.test.js` ("session deny rules") does.

## Done when
`bash tests/run.sh` passes, the button opens the session with the right first
message, each outcome does its app action, and Save & close writes
`projects/sessions/` for a vault session only.
