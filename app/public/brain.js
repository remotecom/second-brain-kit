// Second Brain app front end: a control room for the vault's bots.
// Left: Today + bots grouped by job. Middle: the selected page. Right: log drawer.
// Talking to the vault happens in Claude Code / Cowork, not here.
(() => {
  const $ = (s) => document.querySelector(s);
  const TOKEN = window.BRAIN_TOKEN;
  const api = (p, opt = {}) =>
    fetch(p, { ...opt, headers: { ...(opt.headers || {}), 'Content-Type': 'application/json', 'X-Brain-Token': TOKEN } })
      .then((r) => r.json());
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // Groups are a view over the bot registry; a bot not listed here lands in "Other".
  const GROUPS = [
    { id: 'g-daily', name: 'Daily', bots: ['morning', 'brief'] },
    { id: 'g-syncs', name: 'Syncs', bots: ['sync-slack', 'sync-gcal', 'sync-linear', 'sync-notion', 'sync-gdrive'] },
    { id: 'g-wiki', name: 'Wiki upkeep', bots: ['ingest', 'verify', 'resolve', 'restructure'] },
    { id: 'g-checks', name: 'Checks', bots: ['health', 'lint', 'deltas'] },
  ];

  let vaultName = 'obsidian';
  let bots = [];
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

  // --- data ---
  async function load() {
    let r;
    try { r = await api('/api/brain/bots'); } catch { schedulePoll(15000); return; }
    vaultName = (r.vault || '').split('/').pop() || vaultName;
    bots = r.bots || [];
    sched = r.schedule || {};
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
    if (html !== lastNav) { lastNav = html; $('#nav').innerHTML = html; }
  }

  // Only touch the DOM when the page changed, so polling never resets the
  // scroll position of a preview you are reading.
  let lastPage = '';
  function paintPage() {
    const g = GROUPS.find((x) => x.id === sel);
    const b = byId(sel);
    const html = sel === 'today' ? todayPage() : g ? groupPage(g) : b ? botPage(b) : '<div class="empty">Pick something on the left.</div>';
    if (html === lastPage) return;
    const doc = document.querySelector('#page .doc');
    const keep = doc ? doc.scrollTop : 0;
    lastPage = html;
    $('#page').innerHTML = html;
    const doc2 = document.querySelector('#page .doc');
    if (doc2 && keep) doc2.scrollTop = keep;
  }

  function todayPage() {
    const list = todos();
    const m = byId('morning');
    const ml = m && m.last;
    const head = `<h1>Today</h1><div class="sub">${ml ? `Last Morning run ${ago(ml.endedAt || ml.startedAt)} · <span class="pill ${status(m)}">${status(m)}</span>${ml.costUsd ? ` · $${ml.costUsd.toFixed(2)}` : ''}` : 'The Morning run has not run yet.'}</div>`;
    const moves = list.length ? list.map(({ bot, todo }) => moveCard(bot, todo, true)).join('') : '<div class="empty">Nothing is waiting on you.</div>';
    const brief = briefText ? `<div class="card brief"><div class="k" style="color:var(--muted)">Today's brief</div><div class="doc">${render(briefText.replace(/^---[\s\S]*?---\n/, ''))}</div>
      <div class="row"><a href="${obsidian('Brief.md')}"><button class="ghost small">Open in Obsidian</button></a></div></div>` : '';
    return head + moves + brief;
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

  function botPage(b) {
    const l = b.last;
    const st = status(b);
    const sub = l ? `Last run ${ago(l.endedAt || l.startedAt)}${l.costUsd ? ` · $${l.costUsd.toFixed(2)}` : ''}` : 'Never run';
    const sum = st === 'running' ? 'Running now. Open the log to watch it.' : l ? l.summary : (b.kind === 'later' ? 'Designed, not built yet.' : 'Press Run to try it.');
    return `<h1>${esc(b.name)} <span class="pill ${st}">${st}</span><span class="spacer"></span>${runButton(b)}</h1>
      <div class="sub">${esc(sub)}</div>
      <div class="summary">${esc(sum)}</div>
      ${b.todo && b.id !== 'resolve' ? moveCard(b, b.todo, false) : ''}
      ${preview && preview.botId === b.id ? previewBlock() : ''}
      ${b.id === 'resolve' ? needsBlock() : ''}
      <div class="what"><b>What it does.</b> ${esc(b.blurb)}</div>`;
  }

  function moveCard(b, t, showFrom) {
    return `<div class="card move"><div class="k">Your move</div>
      ${showFrom ? `<div class="from">from <a href="#" data-sel="${b.id}" style="color:var(--accent)">${esc(b.name)}</a></div>` : ''}
      <div>${esc(t.text)}</div>
      ${(t.items || []).map((it) => `
        <div class="t">${esc(it.title)}</div>
        ${it.note ? `<div class="n">${noteHtml(it.note)}</div>` : ''}
        <div class="row">
          ${(it.actions || []).map((a) => `<button class="small" data-act="${esc(a.kind)}" data-slug="${esc(a.slug || '')}" data-confirm="${esc(a.confirm || '')}">${esc(a.label)}</button>`).join('')}
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
      return `<div class="card need"><div class="nid">${esc(isC ? 'Contradiction' : 'Possibly missing')} · ${esc(it.date)} · <span class="muted">${esc(it.id)}</span></div>
        ${claims ? '' : `<div class="ntext doc">${render(it.text)}</div>`}
        ${it.boxes.map(choice).join('')}</div>`;
    }).join('');
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
