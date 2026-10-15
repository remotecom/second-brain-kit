// Second Brain app front end: a control room for the vault's bots.
// Left: Today + bots grouped by job. Middle: the selected page. Right: log drawer.
// Talking to the vault happens in Claude Code / Cowork, not here.
(() => {
  const $ = (s) => document.querySelector(s);
  const TOKEN = window.BRAIN_TOKEN;
  const api = (p, opt = {}) =>
    fetch(p, { ...opt, headers: { ...(opt.headers || {}), 'Content-Type': 'application/json', 'X-Brain-Token': TOKEN } })
      .then((r) => r.json());
  // Outside links open in a normal browser tab, through the server: from this
  // --app window Chrome would open them as another app window (no tabs, no
  // URL bar). Pages and session.js both use this.
  window.openLink = (uri) => api('/api/brain/open', { method: 'POST', body: JSON.stringify({ url: uri }) })
    .then((r) => { if (r && r.error) console.warn('open link:', r.error); });
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented) return;
    let u; try { u = new URL(a.getAttribute('href'), location.href); } catch { return; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin === location.origin) return;
    e.preventDefault();
    window.openLink(u.href);
  });
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // Groups are a view over the bot registry; a bot not listed here lands in "Other".
  const GROUPS = [
    { id: 'g-daily', name: 'Daily', bots: ['morning', 'brief'] },
    { id: 'g-syncs', name: 'Syncs', bots: ['sync-slack', 'sync-gcal', 'sync-linear', 'sync-notion', 'sync-gdrive', 'rescope'] },
    { id: 'g-wiki', name: 'Wiki upkeep', bots: ['ingest', 'verify', 'resolve', 'restructure'] },
    { id: 'g-checks', name: 'Checks', bots: ['health', 'lint', 'deltas'] },
  ];

  let vaultName = 'obsidian';
  let bots = [];
  let setup = [];
  let kitUpdate = null;
  let usage = null;
  let sessions = [];
  let cmp = null; // restructure compare: { slug, data, sec: { i, before, after, ... } }
  let chatModel = store.get('brain.chatModel', 'sonnet');
  let transcript = null; // { id, lines } on the Sessions page
  let sched = {};
  let sel = store.get('brain.sel', 'today');
  let open = store.get('brain.open', { 'g-daily': true, 'g-syncs': false, 'g-wiki': true, 'g-checks': false });
  let preview = null; // { botId, path, text }
  let pollTimer = null;
  let briefText = '';
  let needs = [];

  // --- tiny markdown: escape first, then code/bold/bullets/headings/wikilinks ---
  function render(md) {
    const lines = esc(md).split('\n');
    let html = '', inList = false;
    for (const raw of lines) {
      const l = raw
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
          const file = target.trim();
          return `<a class="wl" href="${obsidian(file)}" title="Open in Obsidian">${label || file.split('/').pop()}</a>`;
        });
      const bullet = l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
      if (bullet) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${bullet[1]}</li>`; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      if (/^#{1,4}\s+/.test(l)) html += `<p class="h">${l.replace(/^#{1,4}\s+/, '')}</p>`;
      else if (l.trim() && l.trim() !== '---') html += `<p>${l}</p>`;
    }
    return html + (inList ? '</ul>' : '');
  }
  const obsidian = (f) => `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(f)}`;

  function ago(iso) {
    if (!iso) return '';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  const status = (b) => (b && b.last ? b.last.status : 'never');
  const short = (b) => b.name.replace(/^Sync /, '');
  const byId = (id) => bots.find((b) => b.id === id);
  const RANK = { error: 4, running: 3, warn: 2, ok: 1, never: 0 };
  function groupStatus(g) {
    return g.bots.map(byId).filter(Boolean).map(status).sort((a, b) => RANK[b] - RANK[a])[0] || 'never';
  }
  const todos = () => bots.filter((b) => b.todo).map((b) => ({ bot: b, todo: b.todo }));

  // After a session ends, go to the page its result shows on.
  const DONE_PAGE = { restructure: () => 'restructure', needs: () => 'resolve', repair: () => 'today', connector: (s) => s.item && s.item.bot, findings: (s) => s.item && s.item.bot, shape: () => 'setup' };
  window.SessionPanel.init({ api, esc: (x) => esc(x),
    onChange: (showLog) => { if (showLog && !document.body.classList.contains('with-spanel')) { $('#drawer').hidden = false; store.set('brain.drawer', true); } load(); },
    onDone: (s) => { const f = s && DONE_PAGE[s.kind]; const id = f && f(s); if (id) { cmp = null; select(id); } } });

  // --- data ---
  async function load() {
    let r;
    try { r = await api('/api/brain/bots'); } catch { schedulePoll(15000); return; }
    vaultName = (r.vault || '').split('/').pop() || vaultName;
    bots = r.bots || [];
    try { sessions = (await api('/api/sessions')).sessions || []; } catch {}
    sched = r.schedule || {};
    setup = r.setup || [];
    kitUpdate = r.update || null;
    usage = r.usage || null;
    try { const f = await api('/api/brain/file?path=Brief.md'); briefText = f.text || ''; } catch {}
    try { needs = (await api('/api/brain/needs')).items || []; } catch {}
    const known = new Set(GROUPS.flatMap((g) => g.bots));
    const other = bots.filter((b) => !known.has(b.id)).map((b) => b.id);
    if (other.length && !GROUPS.find((g) => g.id === 'g-other')) GROUPS.push({ id: 'g-other', name: 'Other', bots: other });
    paint();
    schedulePoll(bots.some((b) => status(b) === 'running') ? 2000 : 15000);
  }
  function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(load, ms); }

  // --- paint ---
  function paint() {
    $('#bar-sched').textContent = !sched.enabled ? 'schedule off (config.yaml)'
      : `Morning run ${sched.morningAt} · next ${/^\d{4}-/.test(sched.next || '') ? new Date(sched.next).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : sched.next || '?'}`;
    paintNav();
    paintPage();
    paintDrawer();
  }

  let lastNav = '';
  function paintNav() {
    const n = todos().length;
    let html = `<div class="nav-item ${sel === 'today' ? 'sel' : ''}" data-sel="today"><span class="lbl">Today</span>${n ? `<span class="badge">${n}</span>` : ''}</div>`;
    for (const g of GROUPS) {
      const members = g.bots.map(byId).filter(Boolean);
      if (!members.length) continue;
      const waiting = members.filter((b) => b.todo).length;
      html += `<div class="nav-item group ${sel === g.id ? 'sel' : ''}" data-sel="${g.id}">
        <span class="caret" data-toggle="${g.id}">${open[g.id] ? '▾' : '▸'}</span>
        <span class="lbl">${esc(g.name)}</span>${waiting ? `<span class="badge">${waiting}</span>` : ''}<span class="dot ${groupStatus(g)}"></span></div>`;
      if (open[g.id]) {
        for (const b of members) {
          html += `<div class="nav-item child ${sel === b.id ? 'sel' : ''}" data-sel="${b.id}">
            <span class="dot ${status(b)}"></span><span class="lbl">${esc(short(b))}</span>${b.todo ? '<span class="badge">!</span>' : ''}</div>`;
        }
      }
    }
    // Sessions: the open and asleep ones, in the owner's order (drag to move,
    // double-click to rename); done ones on the page.
    const live = sessions.filter((s) => s.state !== 'done');
    html += `<div class="nav-item group ${sel === 'chat' ? 'sel' : ''}" data-sel="chat"><span class="lbl">Vault chat</span></div>`;
    html += `<div class="nav-item group ${sel === 'sessions' ? 'sel' : ''}" data-sel="sessions"><span class="lbl">Sessions</span>${live.length ? `<span class="badge">${live.length}</span>` : ''}</div>`;
    for (const s of live.slice(0, 8)) html += `<div class="nav-item child" draggable="true" data-session="${esc(s.id)}" title="Drag to move · double-click to rename"><span class="dot ${s.running ? 'running' : 'never'}"></span><span class="lbl">${esc(s.title)}</span></div>`;
    const needsSetup = setup.some((f) => f.level === 'error');
    html += `<div class="nav-foot">
      <div class="nav-item ${sel === 'setup' ? 'sel' : ''}" data-sel="setup"><span class="lbl">Setup</span>${needsSetup ? '<span class="badge">!</span>' : ''}</div>
      <a class="nav-item" href="obsidian://open?vault=${encodeURIComponent(vaultName)}"><span class="lbl">Open in Obsidian ↗</span></a></div>`;
    // A redraw mid-drag would drop the item being dragged: wait for the drop.
    if (html !== lastNav && !dragId) { lastNav = html; $('#nav').innerHTML = html; }
  }

  // --- sessions in the nav: drag to reorder, double-click to rename ---
  let dragId = null;
  const nav = $('#nav');
  const liveIds = () => [...nav.querySelectorAll('[data-session]')].map((x) => x.dataset.session);
  nav.addEventListener('dragstart', (e) => {
    const it = e.target.closest && e.target.closest('[data-session]');
    if (!it) return;
    dragId = it.dataset.session;
    it.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch {}
  });
  nav.addEventListener('dragover', (e) => {
    const it = dragId && e.target.closest && e.target.closest('[data-session]');
    if (!it || it.dataset.session === dragId) return;
    e.preventDefault();
    const r = it.getBoundingClientRect();
    const moving = nav.querySelector(`[data-session="${dragId}"]`);
    if (moving) it.parentNode.insertBefore(moving, e.clientY < r.top + r.height / 2 ? it : it.nextSibling);
  });
  nav.addEventListener('drop', (e) => { if (dragId) e.preventDefault(); });
  nav.addEventListener('dragend', async () => {
    if (!dragId) return;
    const moved = nav.querySelector(`[data-session="${dragId}"]`);
    if (moved) moved.classList.remove('dragging');
    const ids = liveIds();
    dragId = null;
    const r = await api('/api/sessions/order', { method: 'POST', body: JSON.stringify({ ids }) });
    if (r.sessions) sessions = r.sessions;
    lastNav = ''; paintNav();
  });
  nav.addEventListener('dblclick', (e) => {
    const it = e.target.closest && e.target.closest('[data-session]');
    if (it) renameSession(it.dataset.session);
  });
  async function renameSession(id) {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    const name = prompt('Rename this session', s.title);
    if (!name || name.trim() === s.title) return;
    const r = await api(`/api/sessions/${id}/rename`, { method: 'POST', body: JSON.stringify({ title: name }) });
    if (r.error) return alert(r.error);
    sessions = sessions.map((x) => (x.id === id ? r.session : x));
    lastNav = ''; lastPage = ''; paint();
  }

  // Only touch the DOM when the page changed, so polling never resets the
  // scroll position of a preview you are reading.
  let lastPage = '';
  function paintPage() {
    // The Setup page owns its own DOM (public/setup.js): mount it once.
    if (sel === 'setup') {
      if (lastPage !== '__setup__') { lastPage = '__setup__'; window.SetupPage.mount($('#page'), { api, esc, onChange: (showLog) => { if (showLog) { $('#drawer').hidden = false; store.set('brain.drawer', true); } load(); } }); }
      return;
    }
    if (lastPage === '__setup__') window.SetupPage.unmount($('#page'));
    const g = GROUPS.find((x) => x.id === sel);
    const b = byId(sel);
    const html = sel === 'today' ? todayPage() : sel === 'sessions' ? sessionsPage() : sel === 'chat' ? chatPage() : g ? groupPage(g) : b ? botPage(b) : '<div class="empty">Pick something on the left.</div>';
    if (html === lastPage) return;
    const doc = document.querySelector('#page .doc');
    const keep = doc ? doc.scrollTop : 0;
    lastPage = html;
    $('#page').innerHTML = html;
    const doc2 = document.querySelector('#page .doc');
    if (doc2 && keep) doc2.scrollTop = keep;
  }

  // What the doctor found. Errors stop the bots they name; warnings do not.
  function setupCard() {
    const errs = setup.filter((f) => f.level === 'error'), warns = setup.filter((f) => f.level === 'warn');
    if (!errs.length && !warns.length) return '';
    const line = (f) => `<div class="t">${esc(f.message)}</div>${f.fix ? `<div class="n">${esc(f.fix)}</div>` : ''}`;
    const fixable = errs.some((f) => f.repair);
    return `<div class="card ${errs.length ? 'move' : ''}"><div class="k">${errs.length ? `Setup issues · ${errs.length} stop a bot` : 'Setup notes'}</div>
      ${errs.map(line).join('')}${warns.length ? `<details${errs.length ? '' : ' open'}><summary class="n">${warns.length} note(s) that do not stop anything</summary>${warns.map(line).join('')}</details>` : ''}
      <div class="row">${fixable ? '<button class="small" data-act="repair" data-confirm="Create the missing folders and starter files? Nothing that exists is changed.">Repair</button>' : ''}
      ${errs.length ? '<button class="small ghost" data-act="session" data-slug="repair" data-body="{}">Repair in a session</button>' : ''}</div></div>`;
  }

  function updateCard() {
    const u = kitUpdate;
    if (!u || !u.behind) return '';
    return `<div class="card"><div class="k" style="color:var(--accent)">Kit update · ${u.behind} new commit(s)</div>
      <div class="n">${(u.log || []).slice(0, 6).map((l) => esc(l)).join('<br>')}</div>
      <div class="row"><button class="small" data-update>Update</button><span class="muted">Adds new config keys (never changes yours) and refreshes the kit block in CLAUDE.md. The app restarts.</span></div></div>`;
  }

  function todayPage() {
    const list = todos();
    const m = byId('morning');
    const ml = m && m.last;
    const head = `<h1>Today</h1><div class="sub">${ml ? `Last Morning run ${ago(ml.endedAt || ml.startedAt)} · <span class="pill ${status(m)}">${status(m)}</span>` : 'The Morning run has not run yet.'}${usage ? ` · <span class="${usage.ok ? '' : 'warn'}" title="The bots use your claude.ai plan. This is the rise in the plan's weekly use during bot runs today; your own use at the same time counts too.">${esc(usage.text)}</span>` : ''}</div>`;
    const moves = list.length ? list.map(({ bot, todo }) => moveCard(bot, todo, true)).join('') : (setup.some((f) => f.level === 'error') ? '' : '<div class="empty">Nothing is waiting on you.</div>');
    const brief = briefText ? `<div class="card brief"><div class="k" style="color:var(--muted)">Today's brief</div><div class="doc">${render(briefText.replace(/^---[\s\S]*?---\n/, ''))}</div>
      <div class="row"><a href="${obsidian('Brief.md')}"><button class="ghost small">Open in Obsidian</button></a></div></div>` : '';
    return head + setupCard() + updateCard() + moves + brief;
  }

  function groupPage(g) {
    const members = g.bots.map(byId).filter(Boolean);
    const rows = members.map((b) => {
      const l = b.last;
      const sum = b.kind === 'later' ? b.blurb : l ? (status(b) === 'running' ? 'running…' : l.summary) : 'never run';
      return `<tr data-sel="${b.id}">
        <td class="nm"><span class="dot ${status(b)}" style="display:inline-block;margin-right:8px"></span>${esc(short(b))}${b.todo ? ' <span class="badge">!</span>' : ''}</td>
        <td class="sm">${esc(sum)}</td>
        <td class="r">${l && l.endedAt ? ago(l.endedAt) : ''}${l && l.costUsd ? `<br>$${l.costUsd.toFixed(2)}` : ''}</td>
        <td class="r">${runButton(b)}</td></tr>`;
    }).join('');
    return `<h1>${esc(g.name)}</h1><div class="sub">${members.length} bots. Click one for details.</div><table class="members">${rows}</table>`;
  }

  function runButton(b) {
    if (b.kind === 'later') return '<span class="muted">not built</span>';
    const running = status(b) === 'running';
    return `<button class="ghost small" data-run="${b.id}" ${running ? 'disabled' : ''}>${running ? 'Running…' : 'Run'}</button>`;
  }

  // Every session, open and done, in the owner's order.
  function sessionsPage() {
    const row = (s) => `<tr><td><span class="dot ${s.running ? 'running' : s.state === 'done' ? 'ok' : 'never'}" style="display:inline-block;margin-right:8px"></span>${esc(s.title)} <button class="ghost small" data-rename="${esc(s.id)}" title="Rename">✎</button>${(s.saved || []).length ? `<div class="muted" style="font-size:11px">saved to ${s.saved.map((x) => esc(x)).join(', ')}</div>` : ''}</td>
      <td class="muted">${esc(s.kind)} · ${esc(s.model)}</td><td>${esc(s.state)}${s.outcome ? ` · ${esc(s.outcome)}` : ''}</td><td class="muted">${ago(s.endedAt ? new Date(s.endedAt).toISOString() : new Date(s.lastInput).toISOString())}</td>
      <td>${s.state === 'done' ? `<button class="ghost small" data-transcript="${esc(s.id)}">Transcript</button>` : `<button class="small" data-session="${esc(s.id)}">Open</button>`}</td></tr>`;
    const open = sessions.filter((s) => s.state !== 'done'), done = sessions.filter((s) => s.state === 'done');
    const tr = transcript ? `<div class="card"><div class="k" style="color:var(--muted)">Transcript</div><div class="doc">${transcript.lines.map((l) => `<p><b>${l.who === 'user' ? 'You' : 'Claude'}:</b> ${esc(l.text).replace(/\n/g, '<br>')}</p>`).join('') || '<p class="muted">Empty.</p>'}</div></div>` : '';
    return `<h1>Sessions</h1><div class="sub">Real Claude Code sessions the app opened next to an item. At most ${esc(String(4))} run at once; one with no input for 30 minutes goes to sleep and continues where it stopped when you open it.</div>
      <div class="sub"><b>Save &amp; close</b> on a session copies it, word for word, to <code>projects/sessions/</code> in your vault (credentials redacted). The next ingest folds it into the wiki, as it does every raw file. Plain <b>Close</b> saves nothing.</div>
      <table class="t"><thead><tr><th>Open</th><th></th><th></th><th></th><th></th></tr></thead><tbody>${open.map(row).join('') || '<tr><td class="muted" colspan="5">None.</td></tr>'}</tbody></table>
      <table class="t"><thead><tr><th>Done</th><th></th><th></th><th></th><th></th></tr></thead><tbody>${done.map(row).join('') || '<tr><td class="muted" colspan="5">None yet.</td></tr>'}</tbody></table>${tr}`;
  }

  // Vault chat (T21): a real Claude Code session in the vault.
  function chatPage() {
    const chats = sessions.filter((s) => s.kind === 'chat');
    return `<h1>Vault chat</h1><div class="sub">Ask your vault anything, in a real Claude Code session that reads the vault's CLAUDE.md. Syncs, ingest and the other app jobs go through the app: ask Claude to run them and it uses <code>second-brain run</code>.</div>
      <div class="card"><div class="row">
        <label class="opt"><input type="radio" name="cm" value="opus" ${chatModel === 'opus' ? 'checked' : ''} data-cm> Opus <span class="muted">(research, hard questions)</span></label>
        <label class="opt"><input type="radio" name="cm" value="sonnet" ${chatModel === 'sonnet' ? 'checked' : ''} data-cm> Sonnet <span class="muted">(daily work)</span></label>
        <label class="opt"><input type="radio" name="cm" value="haiku" ${chatModel === 'haiku' ? 'checked' : ''} data-cm> Haiku <span class="muted">(quick facts)</span></label>
      </div><div class="row"><button data-chat>New chat</button></div></div>
      ${chats.length ? `<table class="t"><tbody>${chats.map((s) => `<tr><td>${esc(s.title)}</td><td class="muted">${esc(s.model)} · ${esc(s.state)}</td><td>${s.state === 'done' ? `<button class="ghost small" data-transcript="${esc(s.id)}">Transcript</button>` : `<button class="small" data-session="${esc(s.id)}">Open</button>`}</td></tr>`).join('')}</tbody></table>` : ''}`;
  }

  function botPage(b) {
    const l = b.last;
    const st = status(b);
    const sub = l ? `Last run ${ago(l.endedAt || l.startedAt)}${l.costUsd ? ` · $${l.costUsd.toFixed(2)}` : ''}` : 'Never run';
    const sum = st === 'running' ? (RUNNING[b.id] || 'Running now. The log on the right shows each step.') : l ? l.summary : (b.kind === 'later' ? 'Designed, not built yet.' : 'Press Run to try it.');
    return `<h1>${esc(b.name)} <span class="pill ${st}">${st}</span><span class="spacer"></span>${runButton(b)}</h1>
      <div class="sub">${esc(sub)}</div>
      <div class="summary">${esc(sum)}</div>
      ${b.todo && b.id !== 'resolve' ? moveCard(b, b.todo, false) : ''}
      ${lookCard(b)}
      ${preview && preview.botId === b.id ? previewBlock() : ''}
      ${b.id === 'restructure' && cmp ? compareBlock() : ''}
      ${b.id === 'resolve' ? needsBlock() : ''}
      <div class="what"><b>What it does.</b> ${esc(b.blurb)}</div>`;
  }

  // What a long run is doing, in words, while it runs.
  const RUNNING = {
    restructure: 'Staging the split now. Opus writes the new Current state, Timeline and Open questions (about 2 minutes). When it is done, a "Your move" card appears here with Compare. Nothing is applied until you press Apply.',
    ingest: 'Folding new raw files into the wiki, part by part. The log on the right shows each part.',
  };

  // A run that ended warn or error: a place to talk it through, and the way on.
  function lookCard(b) {
    const l = b.last;
    if (!l || status(b) === 'running' || !['warn', 'error'].includes(l.status) || b.id === 'restructure' || b.id === 'resolve') return '';
    const nC = /(\d+) contradiction/.exec(l.summary || '');
    const toNeeds = (b.id === 'ingest' && nC) || b.id === 'verify';
    return `<div class="card look"><div class="k">Your move</div>
      <div>${b.id === 'ingest' && nC ? `Ingest found ${esc(nC[1])} contradiction(s). Verify puts them in Needs-You (it runs in the Morning run, or press Run on Verify). You answer them on the Resolve page.`
        : b.id === 'verify' ? 'Verify\'s findings are in Needs-You. You answer them on the Resolve page.'
        : `This run ended with "${esc(l.status)}". Open a session to go through what it found.`}</div>
      <div class="row">
        ${toNeeds ? `<button class="small" data-act="goto" data-slug="resolve">Answer on Resolve${needs.length ? ` (${needs.length} waiting)` : ''}</button>` : ''}
        <button class="small ${toNeeds ? 'ghost' : ''}" data-act="session" data-slug="findings" data-body="${esc(JSON.stringify({ bot: b.id }))}" title="Open a Claude Code session that reads this run's log and the files it names">Look into this</button>
      </div></div>`;
  }

  function moveCard(b, t, showFrom) {
    return `<div class="card move"><div class="k">Your move</div>
      ${showFrom ? `<div class="from">from <a href="#" data-sel="${b.id}" style="color:var(--accent)">${esc(b.name)}</a></div>` : ''}
      <div>${esc(t.text)}</div>
      ${(t.items || []).map((it) => `
        <div class="t">${esc(it.title)}</div>
        ${it.note ? `<div class="n">${noteHtml(it.note)}</div>` : ''}
        <div class="row">
          ${(it.actions || []).map((a) => `<button class="small" data-act="${esc(a.kind)}" data-slug="${esc(a.slug || '')}" data-url="${esc(a.url || '')}" data-body="${esc(a.body ? JSON.stringify(a.body) : '')}" data-confirm="${esc(a.confirm || '')}">${esc(a.label)}</button>`).join('')}
          ${(it.files || []).map((f) => `<button class="ghost small ${preview && preview.path === f.path ? 'on' : ''}" data-view="${esc(f.path)}" data-bot="${b.id}">View${f.label ? ' ' + esc(f.label) : ''}</button>`).join('')}
          ${it.obsidian ? `<a href="${obsidian(it.obsidian)}"><button class="ghost small">Open in Obsidian</button></a>` : ''}
        </div>`).join('')}
    </div>`;
  }
  // Put the "OUT OF DATE" part of a note on its own line, in warning colour.
  function noteHtml(note) {
    const i = note.indexOf('OUT OF DATE');
    return i < 0 ? esc(note) : `${esc(note.slice(0, i))}<br><span class="stale">${esc(note.slice(i))}</span>`;
  }

  // Needs-You, answerable in place. A contradiction's text is "<claim A> vs <claim B>",
  // so the two claims become the first two choices.
  const LABEL = {
    'the first claim is right': 'First is right',
    'the second claim is right': 'Second is right',
    'both are out of date, ignore': 'Both out of date, ignore',
    'it is already covered, ignore': 'Already covered, ignore',
    're-ingest this file': 'Re-ingest this file',
  };
  function needsBlock() {
    if (!needs.length) return '<div class="empty">Nothing in Needs-You.md is waiting.</div>';
    const picked = needs.filter((it) => it.boxes.some((x) => x.on)).length;
    const head = `<div class="needs-head"><b>${needs.length} waiting</b><span class="muted"> · ${picked} answered</span><span class="spacer"></span>
      <button data-run="resolve" ${picked && status(byId('resolve')) !== 'running' ? '' : 'disabled'}>Apply my answers${picked ? ` (${picked})` : ''}</button></div>`;
    return head + needs.map((it) => {
      const isC = it.id.startsWith('c-');
      const parts = isC ? it.text.split(/\s+vs\.?\s+/) : [];
      const claims = parts.length >= 2 ? [parts[0], parts.slice(1).join(' vs ')] : null;
      const choice = (bx, i) => {
        const detail = claims && i < 2 ? `<div class="cl">${render(claims[i])}</div>` : '';
        return `<div class="choice ${bx.on ? 'on' : ''}" data-need="${it.id}" data-label="${esc(bx.label)}">
          <span class="radio"></span><div><div class="cn">${esc(LABEL[bx.label] || bx.label)}</div>${detail}</div></div>`;
      };
      // Where each claim is written (A7): checked quotes with links. Older
      // items, and items ingest gave no sources for, show their text only.
      const src = it.sources;
      const side = (k, n) => {
        const x = src && src[k];
        if (!x) return `<div class="claim"><div class="k">Claim ${n}</div><div class="muted">${claims ? esc(claims[n - 1]) : ''}</div></div>`;
        return `<div class="claim"><div class="k">Claim ${n}</div>${x.quote ? `<blockquote>${esc(x.quote)}</blockquote>` : ''}
          <div class="from">${x.page ? `<a href="${obsidian(x.page)}">${esc(x.page)}</a>` : ''}${x.file && x.file !== x.page ? ` · in <a href="${obsidian(x.file)}">${esc(x.file)}</a>` : ''}${x.line ? ` · line ${x.line}` : ''}</div></div>`;
      };
      const evidence = isC && src ? `<div class="claims">${side('a', 1)}${side('b', 2)}</div>` : '';
      return `<div class="card need"><div class="nid">${esc(isC ? 'Contradiction' : 'Possibly missing')} · ${esc(it.date)} · <span class="muted">${esc(it.id)}</span>
        <span class="spacer"></span><button class="ghost small" data-act="session" data-slug="needs" data-body="${esc(JSON.stringify({ id: it.id }))}" title="Open a Claude Code session that reads the sources and says which choice they support">Look into this</button></div>
        ${claims ? '' : `<div class="ntext doc">${render(it.text)}</div>`}
        ${evidence}
        ${it.boxes.map(choice).join('')}</div>`;
    }).join('');
  }

  // T24: what the staged split does, section by section. Built by code from
  // the staged files; the model wrote only the green summary sections.
  function compareBlock() {
    const d = cmp.data;
    if (!d) return '<div class="card">Loading the comparison…</div>';
    const kb = (n) => `${Math.round(n / 1024)}KB`;
    const max = Math.max(d.sizes.old, d.sizes.hub + d.sizes.history);
    const bar = (parts) => `<div class="sizebar">${parts.map(([w, c, t]) => `<span class="${c}" style="width:${(100 * w / max).toFixed(2)}%" title="${esc(t)}"></span>`).join('')}</div>`;
    const color = { hub: 'stay', history: 'move', merged: 'stay', new: 'new' };
    const rows = d.sections.map((s) => `<tr class="${cmp.sec && String(cmp.sec.i) === String(s.i) ? 'sel' : ''}" data-cmp-sec="${esc(String(s.i))}">
        <td><span class="sw ${s.kind === 'new' ? 'new' : color[s.goes]}"></span>${esc(s.head)}</td><td class="muted">${esc(s.kind === 'new' ? 'new on hub' : s.goes === 'history' ? 'moves' : s.goes === 'merged' ? 'merged' : 'stays')}</td>
        <td class="muted">${kb(s.bytes)}</td><td>${d.comments[s.head] ? '💬' : ''}</td></tr>`).join('');
    const sec = cmp.sec;
    const why = sec && (d.sections.find((x) => String(x.i) === String(sec.i)) || {}).why;
    const detail = !sec ? '<div class="muted">Pick a section to see it before and after.</div>' : `
      <div class="n"><b>${esc(sec.head)}</b>: ${esc(why || '')}</div>
      <div class="ba"><div><div class="k">Before (old page)</div><pre>${esc(sec.before || '(new)')}</pre></div>
      <div><div class="k">After (${esc(sec.where)})${sec.same ? ' · identical' : ''}</div><pre class="${sec.same ? '' : 'changed'}">${esc(sec.after || '(not found)')}</pre></div></div>
      ${sec.missing && sec.missing.length ? `<p class="warn">${sec.missing.length} line(s) of this section are not on the new page.</p>` : ''}
      <div class="row"><textarea data-cmp-comment="${esc(sec.head)}" rows="2" placeholder="A comment on this section, for the re-stage (it goes to the summary writer)">${esc(d.comments[sec.head] || '')}</textarea><button class="small ghost" data-cmp-save>Save comment</button></div>`;
    return `<div class="card compare"><div class="k" style="color:var(--muted)">Compare · ${esc(d.rel)}</div>
      <div class="sizes"><div><span class="muted">Old page</span> ${kb(d.sizes.old)}</div>${bar([[d.sizes.old, 'old', 'old page']])}
      <div><span class="muted">After</span> hub ${kb(d.sizes.hub)} + history ${kb(d.sizes.history)}</div>${bar([[d.stays, 'stay', 'stays on the hub'], [d.added, 'new', 'new summary'], [d.moves, 'move', 'moves to history']])}
      <div class="legend"><span class="sw stay"></span>stays ${kb(d.stays)} <span class="sw move"></span>moves ${kb(d.moves)} <span class="sw new"></span>new ${kb(d.added)}</div></div>
      <div class="cmp-grid"><table class="t"><tbody>${rows}</tbody></table><div class="cmp-detail">${detail}</div></div>
      <div class="row"><button class="small ghost" data-act="session" data-slug="restructure" data-body="${esc(JSON.stringify({ slug: cmp.slug }))}">Ask about this change</button>
      <button class="small ghost" data-cmp-restage ${Object.keys(d.comments).length ? '' : 'disabled'}>Re-stage with my comments (${Object.keys(d.comments).length})</button>
      <button class="small ghost" data-cmp-close>Close compare</button></div></div>`;
  }

  function previewBlock() {
    return `<div class="preview"><div class="tabs"><b>${esc(preview.path)}</b><span class="spacer"></span><button class="ghost small" data-close-preview>Close</button></div>
      <div class="doc">${render(String(preview.text).replace(/^---\n[\s\S]*?\n---\n/, ''))}</div></div>`;
  }

  function paintDrawer() {
    const b = byId(sel);
    const log = $('#drawer-log');
    if (!b) { $('#drawer-sub').textContent = ''; log.textContent = 'Pick a bot to see its last run.'; return; }
    $('#drawer-sub').textContent = b.name;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = b.last ? (b.last.log || []).join('\n') : 'Never run.';
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  // --- actions ---
  function select(id) {
    sel = id; store.set('brain.sel', sel);
    const g = GROUPS.find((x) => x.bots.includes(id));
    if (g && !open[g.id]) { open[g.id] = true; store.set('brain.open', open); }
    if (preview && preview.botId !== id) preview = null;
    paint();
    $('#page').scrollTop = 0;
  }

  async function run(id, btn) {
    btn.disabled = true;
    const r = await api(`/api/brain/bots/${id}/run`, { method: 'POST', body: '{}' });
    if (r.error) alert(r.error);
    load();
  }

  async function view(botId, p) {
    if (preview && preview.path === p) { preview = null; return paint(); }
    const r = await api(`/api/brain/file?path=${encodeURIComponent(p)}`);
    preview = { botId, path: r.path || p, text: r.error || r.text };
    if (sel !== botId) select(botId); else paint();
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    const tog = t.closest('[data-toggle]');
    if (tog) { open[tog.dataset.toggle] = !open[tog.dataset.toggle]; store.set('brain.open', open); return paint(); }
    const r = t.closest('[data-run]');
    if (r) { ev.stopPropagation(); return r.disabled ? null : run(r.dataset.run, r); }
    const v = t.closest('[data-view]');
    if (v) return view(v.dataset.bot, v.dataset.view);
    if (t.closest('[data-close-preview]')) { preview = null; return paint(); }
    const c = t.closest('[data-need]');
    if (c) {
      if (t.closest('a')) return; // wikilinks inside a claim open Obsidian
      const res = await api('/api/brain/needs/answer', { method: 'POST', body: JSON.stringify({ id: c.dataset.need, label: c.dataset.label }) });
      if (res.error) alert(res.error); else needs = res.items || needs;
      return paint();
    }
    const a = t.closest('[data-act]');
    if (a && a.dataset.act === 'goto') return select(a.dataset.slug);
    // Only https links to claude.ai open from a card (the connector settings).
    if (a && a.dataset.act === 'open-url') { if (/^https:\/\/claude\.ai\//.test(a.dataset.url)) window.open(a.dataset.url, '_blank', 'noopener'); return; }
    if (a && a.dataset.act === 'compare') {
      cmp = { slug: a.dataset.slug, data: null, sec: null }; lastPage = ''; paint();
      cmp.data = await api(`/api/brain/restructure/${encodeURIComponent(a.dataset.slug)}/compare`);
      if (cmp.data.error) { alert(cmp.data.error); cmp = null; }
      lastPage = ''; return paint();
    }
    if (a && a.dataset.act === 'session') {
      let item = {}; try { item = JSON.parse(a.dataset.body || '{}'); } catch {}
      return window.SessionPanel.start(a.dataset.slug, item);
    }
    if (a && a.dataset.act === 'repair') {
      if (a.dataset.confirm && !confirm(a.dataset.confirm)) return;
      a.disabled = true;
      const res = await api('/api/brain/doctor/repair', { method: 'POST', body: '{}' });
      if (res.error) alert(res.error); else alert(res.made && res.made.length ? `Created: ${res.made.join(', ')}` : 'Nothing was missing.');
      return load();
    }
    if (a && a.dataset.act === 'run') {
      a.disabled = true;
      if (a.dataset.confirm && !confirm(a.dataset.confirm)) { a.disabled = false; return; }
      const res = await api(`/api/brain/bots/${encodeURIComponent(a.dataset.slug)}/run`, { method: 'POST', body: a.dataset.body || '{}' });
      if (res.error) alert(res.error);
      $('#drawer').hidden = false; store.set('brain.drawer', true);
      return load();
    }
    if (a) {
      if (a.disabled || (a.dataset.confirm && !confirm(a.dataset.confirm))) return;
      a.disabled = true;
      if (a.dataset.act === 'restructure-apply') {
        const res = await api('/api/brain/restructure/apply', { method: 'POST', body: JSON.stringify({ slug: a.dataset.slug }) });
        if (res.error) alert(res.error);
        preview = null;
        $('#drawer').hidden = false; store.set('brain.drawer', true);
      }
      return load();
    }
    if (cmp) {
      const row = t.closest('[data-cmp-sec]');
      if (row) { const sec = await api(`/api/brain/restructure/${encodeURIComponent(cmp.slug)}/section?i=${encodeURIComponent(row.dataset.cmpSec)}`); const meta = cmp.data.sections.find((x) => String(x.i) === row.dataset.cmpSec); cmp.sec = { i: row.dataset.cmpSec, head: meta.head, ...sec }; lastPage = ''; return paint(); }
      if (t.closest('[data-cmp-save]')) { const ta = document.querySelector('[data-cmp-comment]'); const r = await api(`/api/brain/restructure/${encodeURIComponent(cmp.slug)}/comment`, { method: 'POST', body: JSON.stringify({ head: ta.dataset.cmpComment, text: ta.value }) }); if (r.error) alert(r.error); else cmp.data.comments = r.comments; lastPage = ''; return paint(); }
      if (t.closest('[data-cmp-restage]')) { if (!confirm('Re-stage with your comments? Opus writes the summary again (about $1.40). Nothing is applied yet.')) return; const r = await api(`/api/brain/restructure/${encodeURIComponent(cmp.slug)}/restage`, { method: 'POST', body: '{}' }); if (r.error) alert(r.error); cmp = null; lastPage = ''; $('#drawer').hidden = false; store.set('brain.drawer', true); select('restructure'); return load(); }
      if (t.closest('[data-cmp-close]')) { cmp = null; lastPage = ''; return paint(); }
    }
    if (t.closest('[data-update]')) {
      if (!confirm('Update the kit now? The app restarts when it is done.')) return;
      const r = await api('/api/update', { method: 'POST', body: '{}' });
      if (r.error) return alert(r.error);
      alert('Updating. The app restarts in a moment; this page reloads.');
      return setTimeout(() => location.reload(), 8000);
    }
    const rn = t.closest('[data-rename]');
    if (rn) return renameSession(rn.dataset.rename);
    const so = t.closest('[data-session]');
    if (so) return window.SessionPanel.openId(so.dataset.session);
    const tx = t.closest('[data-transcript]');
    if (tx) { const r = await api(`/api/sessions/${tx.dataset.transcript}/transcript`); transcript = r.error ? { lines: [{ who: 'assistant', text: r.error }] } : { id: tx.dataset.transcript, lines: r.lines }; lastPage = ''; return paint(); }
    if (t.matches && t.matches('[data-cm]')) { chatModel = t.value; store.set('brain.chatModel', chatModel); return; }
    if (t.closest('[data-chat]')) { const m = chatModel; return window.SessionPanel.start('chat', { title: `Chat ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` }, m); }
    const s = t.closest('[data-sel]');
    if (s) { ev.preventDefault(); return select(s.dataset.sel); }
  });

  $('#log-toggle').onclick = () => {
    const d = $('#drawer');
    d.hidden = !d.hidden;
    store.set('brain.drawer', !d.hidden);
    $('#log-toggle').classList.toggle('on', !d.hidden);
  };
  $('#drawer').hidden = !store.get('brain.drawer', false);
  $('#log-toggle').classList.toggle('on', !$('#drawer').hidden);

  load();
})();
