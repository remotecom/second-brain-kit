// node --test: Notion meeting-note transcripts. The second fetch, the cap,
// redact, the exclusion list, the no-change skip, the hold, the backfill
// selector, config, and that ingest gets the transcript text. A whole sync
// runs against a fake connector (buttons.collect replaced before the sync
// module loads). Fixtures are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const buttons = require('../lib/buttons');
let fakeCollect = null;
buttons.collect = (...a) => fakeCollect(...a);
delete require.cache[require.resolve('../lib/notion-mcp')];
const notion = require('../lib/notion-mcp');
const { SOURCES } = require('../lib/sync');
const { writePending, readPending } = require('../lib/ledger');
const C = require('../lib/config');
const { entriesOf, changedOnly } = require('../lib/ingest');

const PLACEHOLDER = 'Transcript omitted. To load it, fetch again with include_transcript: true. Meeting note url: https://notion.example/p/meet#b1';
const meetingText = (transcript, edited = '2026-10-20T15:00:00.000Z') => ({
  title: 'Acme weekly sync', url: 'https://notion.example/meet', page_last_edited_at: edited,
  text: `<content>\n<meeting-notes>\n<meeting-notes-section-summary>\n- Acme ships two demo videos\n</meeting-notes-section-summary>\n<meeting-notes-section-transcript>\n${transcript}\n</meeting-notes-section-transcript>\n</meeting-notes>\n</content>`,
});
const PLAIN = { title: 'Globex plan', url: 'https://notion.example/plan', page_last_edited_at: '2026-10-20T10:00:00.000Z', text: '<content>\nJust a page.\n</content>' };
const TRANSCRIPT = 'Jane Doe: the fields inventory goes dynamic.\nSam Rivera: readiness is not exposed yet.';
const MEET = '11111111aaaa4bbb8ccc000000000001';
const PLAN = '22222222aaaa4bbb8ccc000000000002';
const meta = (extra = {}) => ({ title: 't', url: 'u', timestamp: null, reasons: new Set(['mentioned']), ...extra });

// --- detection, cap, redact -------------------------------------------------------

test('needsTranscript: true only for a transcript section that holds the placeholder', () => {
  assert.equal(notion.needsTranscript(meetingText(PLACEHOLDER).text), true);
  assert.equal(notion.needsTranscript(meetingText(TRANSCRIPT).text), false);
  assert.equal(notion.needsTranscript(PLAIN.text), false);
});

test('capTranscript: cut at a line break under the cap, with the marker; short text and a cut text stay', () => {
  const long = Array.from({ length: 2000 }, (_, i) => `Speaker ${i}: line ${i} of the call.`).join('\n');
  assert.ok(long.length > 60000);
  const c = notion.capTranscript(long, 60000);
  assert.equal(c.cut, true);
  const [kept, marker] = c.text.split('\n\n');
  assert.ok(kept.length <= 60000);
  assert.ok(long.startsWith(`${kept}\n`), 'cut at a whole line');
  assert.equal(marker, '[truncated at 60000 chars, full transcript at the url above]');
  assert.deepEqual(notion.capTranscript('short', 60000), { text: 'short', cut: false });
  assert.deepEqual(notion.capTranscript(c.text, 60000), { text: c.text, cut: true }, 'running twice changes nothing');
});

test('processTranscripts: redacts secrets and cuts transcripts only; the summary and placeholders stay', () => {
  const body = meetingText(`${TRANSCRIPT}\nJane Doe: the password: hunter2 works\n${'x'.repeat(3000)}`).text;
  const r = notion.processTranscripts(body, 1000);
  assert.equal(r.redacted, 1);
  assert.equal(r.cut, true);
  assert.match(r.text, /- Acme ships two demo videos/);
  assert.match(r.text, /password \[credential redacted by sync\] works/);
  assert.doesNotMatch(r.text, /hunter2/);
  assert.match(r.text, /\[truncated at 1000 chars, full transcript at the url above\]\n<\/meeting-notes-section-transcript>/);
  assert.equal(notion.processTranscripts(r.text, 1000).text, r.text, 'idempotent');
  const ph = meetingText(PLACEHOLDER).text;
  assert.equal(notion.processTranscripts(ph, 10).text, ph);
});

// --- exclusions, reuse, hold ------------------------------------------------------

test('excludedBy: matches a page id in either form, or the parent database title', () => {
  assert.equal(notion.excludedBy(MEET, null, ['11111111-aaaa-4bbb-8ccc-000000000001']), '11111111-aaaa-4bbb-8ccc-000000000001');
  assert.equal(notion.excludedBy(MEET, 'Acme 1:1s', ['Acme 1:1s']), 'Acme 1:1s');
  assert.equal(notion.excludedBy(MEET, null, ['Acme 1:1s']), null);
  assert.equal(notion.excludedBy(MEET, 'Globex', []), null);
});

const rawWith = (transcript, edited = '2026-10-20T15:00:00.000Z') => `---\nnotion_id: x\nlast_edited_time: "${edited}"\n---\n\n<meeting-notes-section-transcript>\n${transcript}\n</meeting-notes-section-transcript>\n`;

test('planTranscripts: fetch, reuse when raw has it at the same edit time, excluded; plain pages are left out', () => {
  const pass1 = { [MEET]: meetingText(PLACEHOLDER), [PLAN]: PLAIN, a: meetingText(PLACEHOLDER), b: meetingText(PLACEHOLDER) };
  const raw = { [MEET]: rawWith(TRANSCRIPT), a: rawWith(TRANSCRIPT, '2026-10-19T00:00:00.000Z'), b: '' };
  const tx = { max: 60000, exclude: [] };
  const { plan } = notion.planTranscripts(Object.keys(pass1), (id) => pass1[id], (id) => raw[id] || '', tx, () => meta());
  assert.deepEqual(Object.fromEntries(plan), { [MEET]: 'reuse', a: 'fetch', b: 'fetch' });
  const ex = notion.planTranscripts([MEET], (id) => pass1[id], () => '', { max: 60000, exclude: [MEET] }, () => meta());
  assert.equal(ex.plan.get(MEET), 'excluded');
  assert.deepEqual([...ex.hits], [`notion:transcript:${MEET}`]);
});

test('storedTranscripts: a placeholder, or a cut at another cap, cannot stand in for a fetch', () => {
  assert.equal(notion.storedTranscripts(rawWith(PLACEHOLDER), undefined, 60000), null);
  const cut = rawWith('Jane Doe: hi\n\n[truncated at 50000 chars, full transcript at the url above]');
  assert.equal(notion.storedTranscripts(cut, undefined, 60000), null);
  assert.ok(notion.storedTranscripts(cut, undefined, 50000));
  assert.equal(notion.storedTranscripts('plain page', undefined, 60000), null);
});

test('pickTranscriptPage: full result wins; a failure is held, then falls back to the old raw transcript, then to the placeholder', () => {
  const p1 = meetingText(PLACEHOLDER);
  const full = meetingText(TRANSCRIPT);
  assert.deepEqual(notion.pickTranscriptPage('fetch', p1, full, '', meta(), 60000), { page: full, state: 'fetched' });
  assert.deepEqual(notion.pickTranscriptPage('fetch', p1, undefined, '', meta(), 60000), { hold: true });
  assert.deepEqual(notion.pickTranscriptPage('fetch', p1, meetingText(PLACEHOLDER), '', meta({ attempts: 1 }), 60000), { hold: true }, 'a result that still has the placeholder is a failure');
  const old = notion.pickTranscriptPage('fetch', p1, undefined, rawWith(TRANSCRIPT, '2026-01-01'), meta({ attempts: 2 }), 60000);
  assert.equal(old.state, 'gaveUp');
  assert.equal(old.unfetched, undefined);
  assert.equal(notion.needsTranscript(old.page.text), false, 'a full transcript is never replaced by the placeholder');
  assert.deepEqual(notion.pickTranscriptPage('fetch', p1, undefined, '', meta({ attempts: 2 }), 60000), { page: p1, state: 'gaveUp', unfetched: true });
  assert.deepEqual(notion.pickTranscriptPage('excluded', p1, undefined, '', meta(), 60000), { page: p1, state: 'excluded' });
});

test('renderPage: transcript_truncated and transcript_fetched: false in frontmatter', () => {
  const r = notion.renderPage(MEET, meta(), meetingText('y'.repeat(2000)), '', { maxTranscript: 1000 });
  assert.equal(r.cut, true);
  assert.match(r.md, /^transcript_truncated: true$/m);
  const u = notion.renderPage(MEET, meta(), meetingText(PLACEHOLDER), '', { maxTranscript: 1000, transcriptUnfetched: true });
  assert.match(u.md, /^transcript_fetched: false$/m);
  assert.match(u.md, /Transcript omitted\. To load it/);
});

// --- backfill selector --------------------------------------------------------------

const tmpVault = () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notion-tx-'));
  fs.mkdirSync(path.join(v, 'notion', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(v, 'wiki'), { recursive: true });
  return v;
};
const rawPage = (id, body, extra = '') => `---\nnotion_type: page\nnotion_id: ${id}\ntitle: "Acme sync"\nparent_database: null\nlast_edited_time: "2026-09-01T00:00:00.000Z"\nurl: "https://notion.example/${id}"\nin_scope_reasons: [created_by_me, mentioned]\n${extra}---\n\n# Acme sync\n\n${body}\n`;

test('backfillCandidates: picks a page with the placeholder; skips full, cut, plain, excluded and given-up pages', () => {
  const v = tmpVault();
  const w = (n, t) => fs.writeFileSync(path.join(v, 'notion', 'pages', `${n}.md`), t);
  w('a', rawPage('aaaaaaaa-0000-4000-8000-000000000001', meetingText(PLACEHOLDER).text));
  w('b', rawPage('bbbbbbbb-0000-4000-8000-000000000002', meetingText(TRANSCRIPT).text));
  w('c', rawPage('cccccccc-0000-4000-8000-000000000003', meetingText('hi\n\n[truncated at 60000 chars, full transcript at the url above]').text));
  w('d', rawPage('dddddddd-0000-4000-8000-000000000004', 'Just a page. It says Transcript omitted in prose.'));
  w('e', rawPage('eeeeeeee-0000-4000-8000-000000000005', meetingText(PLACEHOLDER).text));
  w('f', rawPage('ffffffff-0000-4000-8000-000000000006', meetingText(PLACEHOLDER).text, 'transcript_fetched: false\n'));
  const got = notion.backfillCandidates(v, ['eeeeeeee-0000-4000-8000-000000000005']);
  assert.deepEqual(got, [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Acme sync', url: 'https://notion.example/aaaaaaaa-0000-4000-8000-000000000001', reasons: ['created_by_me', 'mentioned'] }]);
  assert.deepEqual(notion.backfillCandidates(path.join(v, 'none'), []), []);
});

// --- a whole sync against a fake connector -------------------------------------------

function fakeVault({ transcripts = true, backfill = false } = {}) {
  const v = tmpVault();
  fs.writeFileSync(path.join(v, 'config.yaml'), [
    'config_version: 2', 'owner:', '  name: "Jane Doe"', '  notion_user_id: "00000000-aaaa-4bbb-8ccc-0000000000ff"',
    'sources:', '  notion:', '    enabled: true', '    window_days: 4',
    `    include_meeting_transcripts: ${transcripts}`, `    backfill_transcripts: ${backfill}`, '',
  ].join('\n'));
  writePending(v, 'notion', [MEET, PLAN].map((id) => ({ id, title: 't', url: 'u', timestamp: '2026-10-20', reasons: ['mentioned'] })));
  return v;
}

// Answers like the connector: pass 1 has the placeholder, pass 2 the transcript.
function connector({ failPass2 = false } = {}) {
  const calls = [];
  fakeCollect = async (ctx, run, tool, jobs, opts) => {
    const name = tool.split('__').pop();
    const keyOf = (args) => JSON.stringify(args);
    const results = new Map();
    for (const j of jobs) {
      calls.push({ name, args: j.args, batch: opts.batch });
      let r = null;
      if (name === 'notion-fetch') {
        const meeting = j.args.id === MEET || /^aaaaaaaa/.test(j.args.id);
        if (!meeting) r = PLAIN;
        else if (!j.args.include_transcript) r = meetingText(PLACEHOLDER);
        else r = failPass2 ? null : meetingText(TRANSCRIPT);
      } else if (name === 'notion-get-comments') r = { text: '' };
      else r = null;
      if (r) results.set(keyOf(j.args), [r]); else if (name !== 'notion-search' && name !== 'notion-query-data-sources') continue;
      if (!results.has(keyOf(j.args))) results.set(keyOf(j.args), []);
    }
    return { results, keyOf, unfinished: [], cost: 0 };
  };
  return calls;
}

async function runSync(v) {
  const lines = []; let done = null;
  await notion.syncNotionMcp({ id: 'r1' }, { vault: v, src: SOURCES.notion, logLine: (r, s) => lines.push(s), finish: (r, status, summary) => { done = { status, summary }; } });
  return { lines, done };
}

const fetches = (calls) => calls.filter((c) => c.name === 'notion-fetch');

test('sync: plain page gets {id} only; the meeting page gets a second fetch with include_transcript in small batches', async () => {
  const v = fakeVault();
  const calls = connector();
  const { done, lines } = await runSync(v);
  assert.equal(done.status, 'ok', `${done.summary}\n${lines.join('\n')}`);
  const f = fetches(calls);
  assert.deepEqual(f.filter((c) => c.args.id === PLAN).map((c) => c.args), [{ id: PLAN }]);
  assert.deepEqual(f.filter((c) => c.args.id === MEET).map((c) => c.args), [{ id: MEET }, { id: MEET, include_transcript: true }]);
  assert.equal(f.find((c) => c.args.include_transcript).batch, 3);
  const raw = fs.readFileSync(path.join(v, 'notion', 'pages', `${MEET}.md`), 'utf8');
  assert.match(raw, /readiness is not exposed yet/);
  assert.doesNotMatch(raw, /Transcript omitted/);
  assert.ok(lines.some((l) => /^transcripts: 1 meeting page\(s\) · 1 fetched/.test(l)), lines.join('\n'));

  // Next run, nothing changed: the stored transcript is reused, no second fetch.
  writePending(v, 'notion', [MEET].map((id) => ({ id, title: 't', url: 'u', timestamp: '2026-10-20', reasons: ['mentioned'] })));
  const again = connector();
  const second = await runSync(v);
  assert.deepEqual(fetches(again).map((c) => c.args), [{ id: MEET }]);
  assert.equal(fs.readFileSync(path.join(v, 'notion', 'pages', `${MEET}.md`), 'utf8'), raw);
  assert.ok(second.lines.some((l) => /1 unchanged \(no fetch\)/.test(l)));
});

test('sync: with include_meeting_transcripts off, no second fetch and raw keeps the placeholder', async () => {
  const v = fakeVault({ transcripts: false });
  const calls = connector();
  await runSync(v);
  assert.equal(fetches(calls).filter((c) => c.args.include_transcript).length, 0);
  assert.match(fs.readFileSync(path.join(v, 'notion', 'pages', `${MEET}.md`), 'utf8'), /Transcript omitted/);
});

test('sync: a failed transcript fetch holds the page in the pending ledger, not written with the placeholder', async () => {
  const v = fakeVault();
  connector({ failPass2: true });
  const { done } = await runSync(v);
  assert.equal(done.status, 'warn');
  assert.equal(fs.existsSync(path.join(v, 'notion', 'pages', `${MEET}.md`)), false);
  assert.ok(fs.existsSync(path.join(v, 'notion', 'pages', `${PLAN}.md`)));
  const pending = readPending(v, 'notion');
  assert.deepEqual(pending.map((p) => [p.id, p.attempts]), [[MEET, 1]]);
});

test('sync: backfill adds old placeholder pages to the run, and logs when none are left', async () => {
  const v = fakeVault({ backfill: true });
  const old = 'aaaaaaaa-0000-4000-8000-000000000001';
  fs.writeFileSync(path.join(v, 'notion', 'pages', 'aaaaaaaa000040008000000000000001.md'), rawPage(old, meetingText(PLACEHOLDER).text));
  const calls = connector();
  const { lines } = await runSync(v);
  assert.ok(lines.includes('transcript backfill: 1 of 1 old meeting page(s) this run'), lines.join('\n'));
  assert.ok(fetches(calls).some((c) => c.args.id === 'aaaaaaaa000040008000000000000001' && c.args.include_transcript));
  const raw = fs.readFileSync(path.join(v, 'notion', 'pages', 'aaaaaaaa000040008000000000000001.md'), 'utf8');
  assert.match(raw, /readiness is not exposed yet/);
  assert.match(raw, /^in_scope_reasons: \[created_by_me, mentioned\]$/m, 'the file keeps its scope reasons');
  connector();
  const next = await runSync(v);
  assert.ok(next.lines.includes('transcript backfill: done, no old page is missing its transcript'));
});

// --- config -------------------------------------------------------------------------

test('config: transcript keys have defaults, and validate names bad values', () => {
  const v = tmpVault();
  fs.writeFileSync(path.join(v, 'config.yaml'), 'config_version: 2\nowner:\n  name: "Sam"\nsources:\n  notion:\n    include_meeting_transcripts: "yes"\n    max_transcript_chars: 10\n    exclude_transcripts_for: acme\n');
  const keys = C.validate(v).map((f) => f.key);
  for (const k of ['sources.notion.include_meeting_transcripts', 'sources.notion.max_transcript_chars', 'sources.notion.exclude_transcripts_for']) assert.ok(keys.includes(k), `${k} in ${keys}`);
  const d = C.getConfig(tmpVault()).sources.notion;
  assert.deepEqual([d.include_meeting_transcripts, d.max_transcript_chars, d.backfill_transcripts, d.exclude_transcripts_for], [true, 60000, true, []]);
});

// --- ingest -------------------------------------------------------------------------

test('ingest: the transcript text reaches the entries, and the diff of a backfilled page is the transcript', () => {
  const longT = Array.from({ length: 1000 }, (_, i) => `Jane Doe: point ${i} about the Acme fields inventory.`).join('\n');
  const before = rawPage(MEET, meetingText(PLACEHOLDER).text);
  const after = rawPage(MEET, notion.processTranscripts(meetingText(longT).text, 60000).text);
  const all = entriesOf(`notion/pages/${MEET}.md`, after).map((e) => e.text).join('\n');
  assert.ok(longT.length < 60000 && longT.length > 45000, 'under the cap, over one ingest part');
  for (const i of [0, 500, 999]) assert.ok(all.includes(`point ${i} about`), `line ${i} reaches ingest`);
  const d = changedOnly(before, after);
  assert.ok(d.includes('point 0 about') && d.includes('point 999 about'));
  assert.match(d, /Lines removed since the last ingest:\n- Transcript omitted/);
});

test('sync: discovery sends 3 searches, the two "by me" ones with an empty query and no catch-all words', async () => {
  const v = fakeVault();
  const calls = connector();
  const { done, lines } = await runSync(v);
  assert.equal(done.status, 'ok', `${done.summary}\n${lines.join('\n')}`);
  const s = calls.filter((c) => c.name === 'notion-search').map((c) => c.args);
  assert.equal(s.length, 3);
  const byMe = s.filter((a) => a.filters.edited_by_user_ids || a.filters.created_by_user_ids);
  assert.equal(byMe.length, 2);
  for (const a of byMe) { assert.equal(a.query, ''); assert.equal(a.sort, 'last_edited'); }
  assert.ok(!s.some((a) => ['the', 'a', 'Remote'].includes(a.query)), 'no catch-all word reaches the search log');
});
