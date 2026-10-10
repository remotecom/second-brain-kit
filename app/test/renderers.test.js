// node --test: the pure parsers and renderers of the five sync bots, plus
// sync.verify/commit, redact and the pending ledger. Fixtures are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const slack = require('../lib/slack-mcp');
const linear = require('../lib/linear-mcp');
const notion = require('../lib/notion-mcp');
const gdrive = require('../lib/gdrive-mcp');
const gcal = require('../lib/gcal-mcp');
const sync = require('../lib/sync');
const { redact } = require('../lib/redact');
const ledger = require('../lib/ledger');

const tmp = (p = 'sb-render-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

// --- slack-mcp -----------------------------------------------------------------

const SEARCH = `Search results

### Result 1 of 2
Channel: #proj-acme (ID: C0SAMPLE1)
Participants: Jane Doe, Sam Rivera
From: Jane Doe <jane.doe@example.com> (ID: U0SAMPLE2)
Time: 2026-09-25 16:25:16 PDT
Message_ts: 1790000000.000100
Reply count: 3
Permalink: [link](https://acme.slack.com/archives/C0SAMPLE1/p1790000000000100?thread_ts=1790000000.000100)
Text:
Kickoff is Monday.
Second line.
---

### Result 2 of 2
Channel: DM (ID: D0SAMPLE3)
From: Sam Rivera (ID: U0SAMPLE1)
Time: 2026-09-25 04:05:00 PDT
Message_ts: 1790000100.000200
Permalink: [link](https://acme.slack.com/archives/D0SAMPLE3/p1790000100000200)
Text:
Thanks!
---
`;

test('slack parseSearch: splits results and reads channel, author, reply count, thread_ts, text', () => {
  const r = slack.parseSearch(SEARCH);
  assert.equal(r.length, 2);
  assert.equal(r[0].channelLabel, '#proj-acme');
  assert.equal(r[0].channelId, 'C0SAMPLE1');
  assert.equal(r[0].author, 'Jane Doe');
  assert.equal(r[0].authorId, 'U0SAMPLE2');
  assert.equal(r[0].replyCount, 3);
  assert.equal(r[0].ts, '1790000000.000100');
  assert.equal(r[0].threadTs, '1790000000.000100');
  assert.equal(r[0].text, 'Kickoff is Monday.\nSecond line.');
  // No Reply count line and no thread_ts in the permalink -> 0 and null.
  assert.equal(r[1].replyCount, 0);
  assert.equal(r[1].threadTs, null);
  assert.equal(r[1].text, 'Thanks!');
});

test('slack parseSearch: empty or odd input gives no results', () => {
  assert.deepEqual(slack.parseSearch(''), []);
  assert.deepEqual(slack.parseSearch(undefined), []);
  assert.deepEqual(slack.parseSearch('No results found'), []);
});

test('slack parseThread: parent plus replies, reactions dropped, messages without a TS skipped', () => {
  const text = `=== THREAD PARENT MESSAGE ===
From: Jane Doe <jane.doe@example.com> (U0SAMPLE2)
Time: 2026-09-25 16:25:16 PDT
Message TS: 1790000000.000100
Kickoff is Monday.
Reactions: :eyes: 2

=== THREAD REPLIES (2 total) ===
--- Reply 1 of 2 ---
From: Sam Rivera (U0SAMPLE1)
Time: 2026-09-25 16:30:00 PDT
Message TS: 1790000300.000300
Works for me.

--- Reply 2 of 2 ---
From: Sam Rivera (U0SAMPLE1)
Time: 2026-09-25 16:31:00 PDT
no ts here
`;
  const m = slack.parseThread(text);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0], { author: 'Jane Doe', authorId: 'U0SAMPLE2', time: '2026-09-25 16:25:16 PDT', ts: '1790000000.000100', text: 'Kickoff is Monday.' });
  assert.equal(m[1].author, 'Sam Rivera');
  assert.equal(m[1].text, 'Works for me.');
});

test('slack whenOf: 24h time to 12h clock with the day', () => {
  assert.deepEqual(slack.whenOf('2026-09-25 04:25:16 PDT'), { day: '2026-09-25', clock: '4:25 AM' });
  assert.deepEqual(slack.whenOf('2026-09-25 16:05:00 PDT'), { day: '2026-09-25', clock: '4:05 PM' });
  assert.deepEqual(slack.whenOf('2026-09-25 00:10:00 PDT'), { day: '2026-09-25', clock: '12:10 AM' });
  assert.deepEqual(slack.whenOf('2026-09-25 12:00:00 PDT'), { day: '2026-09-25', clock: '12:00 PM' });
  // Unparseable time passes through as the clock, with no day.
  assert.deepEqual(slack.whenOf('yesterday'), { day: '', clock: 'yesterday' });
});

test('slack midnight: unix seconds of local midnight in the zone', () => {
  assert.equal(slack.midnight('2026-10-09', 'UTC'), Date.parse('2026-10-09T00:00:00Z') / 1000);
  // PDT is UTC-7 in October.
  assert.equal(slack.midnight('2026-10-09', 'America/Los_Angeles'), Date.parse('2026-10-09T07:00:00Z') / 1000);
});

// --- linear-mcp -----------------------------------------------------------------

test('linear renderComments: nothing for no comments', () => {
  assert.equal(linear.renderComments([], 'https://linear.example/acme/ACM-1'), '');
});

test('linear renderComments: threads replies under their parent, sorted by time, with a permalink on roots only', () => {
  const url = 'https://linear.example/acme/ACM-1';
  const out = linear.renderComments([
    { id: 'c2', createdAt: '2026-10-02T10:00:00Z', author: { name: 'Sam Rivera' }, body: 'Second root', parentId: null },
    { id: 'c1', createdAt: '2026-10-01T10:00:00Z', author: { name: 'Jane Doe' }, body: 'First root\nline two', parentId: null },
    { id: 'r1', createdAt: '2026-10-01T11:00:00Z', author: null, body: 'A reply', parentId: 'c1' },
  ], url);
  assert.equal(out, [
    '', '## Comments',
    `- **Jane Doe** · 2026-10-01T10:00:00Z [↗](${url}#comment-c1)`,
    '  First root', '  line two',
    '  - **Unknown** · 2026-10-01T11:00:00Z',
    '    A reply',
    `- **Sam Rivera** · 2026-10-02T10:00:00Z [↗](${url}#comment-c2)`,
    '  Second root',
  ].join('\n'));
});

// --- notion-mcp -----------------------------------------------------------------

test('notion renderComments: placeholder when there are no comments', () => {
  assert.equal(notion.renderComments(''), '_No comments._');
  assert.equal(notion.renderComments('<discussions></discussions>'), '_No comments._');
});

test('notion renderComments: author, time, link, context, resolved, mentions and entities', () => {
  const xml = `<discussions>
<discussion text-context="Launch date" resolved="true">
<comment user-url="user://abc/jane.doe@example.com" datetime="2026-10-01T09:00:00Z" url="https://notion.example/p#c1?a=1&amp;b=2">Ship it &lt;soon&gt; <mention-user url="user://x">Sam Rivera</mention-user></comment>
<comment user-url="user://abc/sam.rivera@example.com" datetime="2026-10-01T10:00:00Z">Agreed</comment>
</discussion>
</discussions>`;
  assert.equal(notion.renderComments(xml), [
    '- **jane.doe** · 2026-10-01T09:00:00Z [↗](https://notion.example/p#c1?a=1&b=2) · on "Launch date" · resolved',
    '  Ship it <soon> @Sam Rivera',
    '  - **sam.rivera** · 2026-10-01T10:00:00Z',
    '    Agreed',
  ].join('\n'));
});

test('notion filenameFor: new page gets the flat id, existing dashed file is reused', () => {
  const v = tmp();
  const id = '0a1b2c3d-0000-4000-8000-0123456789ab';
  const flat = id.replace(/-/g, '');
  assert.equal(notion.filenameFor(v, id), `notion/pages/${flat}.md`);
  fs.mkdirSync(path.join(v, 'notion', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(v, 'notion', 'pages', `${id}.md`), 'x');
  assert.equal(notion.filenameFor(v, flat), `notion/pages/${id}.md`); // flat input, dashed on disk
  fs.writeFileSync(path.join(v, 'notion', 'pages', `${flat}.md`), 'x');
  assert.equal(notion.filenameFor(v, id), `notion/pages/${flat}.md`); // flat wins when both exist
});

// --- gdrive-mcp -----------------------------------------------------------------

const META = { id: 'file0000001', title: 'Acme launch plan', mimeType: 'application/vnd.google-apps.document', owner: 'jane.doe@example.com', parentId: 'fold0000001', viewUrl: 'https://drive.example/d/file0000001', createdTime: '2026-09-01T00:00:00Z', modifiedTime: '2026-10-01T00:00:00Z' };

test('gdrive render: frontmatter fields, title heading and body', () => {
  const md = gdrive.render(META, 'Hello world.\n\n', ['owned', 'watched_folder'], 'Plans');
  assert.equal(md, [
    '---', 'gdrive_id: file0000001', 'title: "Acme launch plan"', 'mime_type: application/vnd.google-apps.document',
    'owner: jane.doe@example.com', 'parent_id: fold0000001', 'parent_title: "Plans"', 'web_link: https://drive.example/d/file0000001',
    'created_time: 2026-09-01T00:00:00Z', 'modified_time: 2026-10-01T00:00:00Z', 'in_scope_reasons: [owned, watched_folder]',
    'truncated: false', `tags: [gdrive, gdrive/${gdrive.MIME[META.mimeType]}]`, '---', '', '# Acme launch plan', '', 'Hello world.', '',
  ].join('\n'));
});

test('gdrive render: body over maxBody is cut with the marker and truncated: true', () => {
  const md = gdrive.render(META, 'x'.repeat(30), ['owned'], '', 10);
  assert.match(md, /^truncated: true$/m);
  assert.ok(md.includes(`${'x'.repeat(10)}\n\n[truncated at 10 chars — full document at the web_link above]`));
  assert.ok(!md.includes('x'.repeat(11)));
  // Exactly at the cap is not truncated.
  assert.match(gdrive.render(META, 'x'.repeat(10), ['owned'], '', 10), /^truncated: false$/m);
});

test('gdrive render: inlined comments stay in the body; missing metadata renders as null', () => {
  const md = gdrive.render({ id: 'f2', title: 'Notes', mimeType: 'application/pdf' }, 'Body\n\n[Comment by Sam Rivera]: check this', [], undefined);
  assert.ok(md.includes('[Comment by Sam Rivera]: check this'));
  assert.match(md, /^owner: null$/m);
  assert.match(md, /^parent_id: null$/m);
  assert.match(md, /^parent_title: ""$/m);
  assert.match(md, /^in_scope_reasons: \[\]$/m);
});

// --- gcal-mcp -------------------------------------------------------------------

const O = { tz: 'UTC', maxDesc: 2000 };

test('gcal renderDay: quiet day gets the declared placeholder and event_count 0', () => {
  const md = gcal.renderDay('2026-10-09', ['jane.doe@example.com'], [], { private: 0, declined: 0 }, O);
  assert.equal(md, [
    '---', 'date: 2026-10-09', 'tags: [gcal, daily-sync]', 'calendars: [jane.doe@example.com]', 'event_count: 0',
    'excluded: { private: 0, declined: 0 }', 'truncated: false', '---', '',
    '# Calendar — Friday, October 9, 2026', '', '_No events on the synced calendar this day._', '',
  ].join('\n'));
});

test('gcal renderDay: counts events and exclusions in the frontmatter, renders each event', () => {
  const ev = {
    summary: 'Acme sync', start: { dateTime: '2026-10-09T15:00:00Z' }, end: { dateTime: '2026-10-09T15:30:00Z' },
    organizer: { email: 'jane.doe@example.com', displayName: 'Jane Doe' },
    attendees: [{ email: 'sam.rivera@example.com', responseStatus: 'accepted' }, { email: 'room@example.com', resource: true }],
    hangoutLink: 'https://meet.example/abc', description: 'Agenda',
    attachments: [{ fileUrl: 'https://docs.example.com/document/d/abcdefghij1234/edit', title: 'Plan' }],
  };
  const md = gcal.renderDay('2026-10-09', ['jane.doe@example.com'], [{ e: ev, calendar: 'jane.doe@example.com' }, { e: { summary: 'Offsite', start: { date: '2026-10-09' } }, calendar: 'jane.doe@example.com' }], { private: 2, declined: 1 }, O);
  assert.match(md, /^event_count: 2$/m);
  assert.match(md, /^excluded: \{ private: 2, declined: 1 \}$/m);
  assert.ok(md.includes('## 3:00 PM–3:30 PM · Acme sync'));
  assert.ok(md.includes('- **Organizer:** Jane Doe (jane.doe@example.com)'));
  assert.ok(md.includes('- **Attendees:** sam.rivera@example.com (accepted)')); // room resource dropped
  assert.ok(!md.includes('room@example.com'));
  assert.ok(md.includes('- **Location:** https://meet.example/abc'));
  assert.ok(md.includes('- **Attachments:** [[gdrive/files/abcdefghij1234]] — Plan'));
  assert.ok(md.includes('## All day · Offsite'));
});

test('gcal renderEvent: description over the cap is cut with the marker and flagged', () => {
  const r = gcal.renderEvent({ summary: 'Long', start: { dateTime: '2026-10-09T10:00:00Z' }, description: 'y'.repeat(50) }, 'cal', { tz: 'UTC', maxDesc: 20 });
  assert.equal(r.truncated, true);
  assert.ok(r.md.includes(`${'y'.repeat(20)}\n\n[truncated at 20 chars — full text in the source event]`));
  const day = gcal.renderDay('2026-10-09', ['cal'], [{ e: { summary: 'Long', start: { dateTime: '2026-10-09T10:00:00Z' }, description: 'y'.repeat(50) }, calendar: 'cal' }], { private: 0, declined: 0 }, { tz: 'UTC', maxDesc: 20 });
  assert.match(day, /^truncated: true$/m);
});

test('gcal offsetOn: the UTC offset at local midnight of a day', () => {
  assert.equal(gcal.offsetOn('2026-10-09', 'America/Los_Angeles'), '-07:00');
  assert.equal(gcal.offsetOn('2026-12-09', 'America/Los_Angeles'), '-08:00');
});

// --- sync.verify / sync.commit ---------------------------------------------------

const SRC = { dir: 'slack', dayFiles: false };
const RANGE = { since: Date.parse('2026-10-08T00:00:00Z'), today: Date.parse('2026-10-09T00:00:00Z') };

test('sync verify: a clean model-authored file passes', () => {
  const v = tmp();
  const r = sync.verify(v, SRC, { emitted: [] }, new Map([['slack/2026-10-09.md', '# Slack\n\n- hello\n']]), RANGE);
  assert.deepEqual(r.problems, []);
});

test('sync verify: stand-in text is rejected for model-authored files', () => {
  const v = tmp();
  for (const bad of ['_(35-reply thread over the following week)_', '(see Mentions)', '12 more replies', '3+ further messages']) {
    const r = sync.verify(v, SRC, { emitted: [] }, new Map([['slack/2026-10-09.md', `- msg ${bad}\n`]]), RANGE);
    assert.equal(r.problems.length, 1, bad);
    assert.match(r.problems[0], /^stand-in for missing content in slack\/2026-10-09\.md/);
  }
});

test('sync verify: code-rendered files (modelAuthored: false) skip the stand-in check', () => {
  const v = tmp();
  const r = sync.verify(v, SRC, { emitted: [] }, new Map([['slack/2026-10-09.md', 'Jane wrote: (see above)\n35-reply thread\n']]), RANGE, { modelAuthored: false });
  assert.deepEqual(r.problems, []);
});

test('sync verify: italic gloss is a note, not a blocker', () => {
  const v = tmp();
  const r = sync.verify(v, SRC, { emitted: [] }, new Map([['slack/2026-10-09.md', '- msg _(a long gloss here)_\n']]), RANGE);
  assert.deepEqual(r.problems, []);
  assert.equal(r.notes.length, 1);
});

test('sync verify: files outside the source dir and the watermark file are rejected', () => {
  const v = tmp();
  const files = new Map([['wiki/people/jane-doe.md', 'x'], ['slack/../notion/pages/a.md', 'x'], ['slack/.last-sync', '2026-10-09T00:00:00Z']]);
  const r = sync.verify(v, SRC, { emitted: [] }, files, RANGE);
  assert.ok(r.problems.includes('block outside slack/: wiki/people/jane-doe.md'));
  assert.ok(r.problems.includes('block outside slack/: slack/../notion/pages/a.md'));
  assert.ok(r.problems.includes('block for the watermark file: slack/.last-sync (runner-owned)'));
});

test('sync verify: manifest entries need a file, and day-file sources need every day in range', () => {
  const v = tmp();
  const r = sync.verify(v, { dir: 'gcal', dayFiles: true }, { emitted: ['gcal/2026-10-08.md', 'gcal/2026-10-07.md'] }, new Map([['gcal/2026-10-08.md', 'x']]), RANGE);
  assert.ok(r.problems.includes('manifest lists gcal/2026-10-07.md but no FILE block for it'));
  assert.ok(r.problems.includes('day file not emitted: gcal/2026-10-09.md'));
  assert.ok(!r.problems.some((p) => p.includes('gcal/2026-10-08.md')));
});

test('sync commit: writes new files, skips identical content and leaves its mtime alone', () => {
  const v = tmp();
  const files = new Map([['slack/2026-10-09.md', 'same\n'], ['slack/2026-10-08.md', 'old\n']]);
  assert.deepEqual(sync.commit(v, files), { written: 2, skipped: 0 });
  const p = path.join(v, 'slack', '2026-10-09.md');
  const past = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(p, past, past);
  const again = sync.commit(v, new Map([['slack/2026-10-09.md', 'same\n'], ['slack/2026-10-08.md', 'changed\n']]));
  assert.deepEqual(again, { written: 1, skipped: 1 });
  assert.equal(fs.statSync(p).mtime.getTime(), past.getTime()); // unchanged: mtime untouched
  assert.equal(fs.readFileSync(path.join(v, 'slack', '2026-10-08.md'), 'utf8'), 'changed\n');
});

// --- redact ---------------------------------------------------------------------

test('redact: tokens and keys are replaced and counted; ordinary text is untouched', () => {
  let hits = 0;
  const on = () => { hits++; };
  assert.equal(redact('see xoxb-1234567890-abcdefghij now', on), 'see [credential redacted by sync] now');
  assert.equal(redact('key sk-abcdefghijklmnopqrstuvwx end', on), 'key [credential redacted by sync] end');
  assert.equal(redact('id AKIAABCDEFGHIJKLMNOP', on), 'id [credential redacted by sync]');
  assert.equal(redact('password: hunter2', on), 'password [credential redacted by sync]');
  assert.equal(hits, 4);
  hits = 0;
  const plain = 'We rotated the password policy and the api key docs. Nothing secret here.';
  assert.equal(redact(plain, on), plain);
  assert.equal(hits, 0);
});

// --- ledger ---------------------------------------------------------------------

test('ledger: missing file reads as []; write then read round-trips and de-duplicates', () => {
  const v = tmp();
  assert.deepEqual(ledger.readPending(v, 'slack'), []);
  ledger.writePending(v, 'slack', ['2026-10-08', '2026-10-09', '2026-10-08']);
  assert.deepEqual(ledger.readPending(v, 'slack'), ['2026-10-08', '2026-10-09']);
  ledger.writePending(v, 'notion', [{ id: 'p1', tries: 2 }, { id: 'p1', tries: 2 }]);
  assert.deepEqual(ledger.readPending(v, 'notion'), [{ id: 'p1', tries: 2 }]);
  assert.ok(fs.existsSync(path.join(v, '.bot', 'state', 'slack-pending.json')));
});
