// The session panel (T20): a real Claude Code session on the right, next to
// the item it is about. The terminal is xterm over /ws. The outcome buttons
// are app actions: pressing one makes the app write the result and closes the
// session. When Claude ends a reply with "SUGGEST: <label>", that button is
// highlighted; the choice stays the owner's.
(() => {
  let api = null, esc = null, onChange = () => {}, onDone = () => {};
  let cur = null;      // the session record
  let term = null, fit = null, ws = null;
  let suggested = '';
  const TOKEN = window.BRAIN_TOKEN;
  const strip = (t) => t.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '');

  function el() {
    let p = document.getElementById('spanel');
    if (!p) {
      p = document.createElement('aside');
      p.id = 'spanel';
      p.hidden = true;
      document.getElementById('app').appendChild(p);
      p.addEventListener('click', onClick);
    }
    return p;
  }

  function header() {
    const s = cur;
    const outs = s.state === 'done' ? '' : (s.outcomes || []).map((o) => `<button class="small ${o.label === suggested ? 'suggest' : 'ghost'}" data-outcome="${esc(o.label)}" title="${o.label === suggested ? 'Claude suggests this one' : ''}">${esc(o.label)}${o.label === suggested ? ' ★' : ''}</button>`).join('');
    return `<header>
      <div class="sp-title"><span class="dot ${s.running ? 'running' : 'never'}"></span><b>${esc(s.title)}</b> <span class="muted">${esc(s.model)} · ${esc(s.state)}</span></div>
      <span class="spacer"></span>
      ${s.state === 'done' ? '' : `<button class="ghost small" data-sp="sleep" title="Stop the process; keep the session to continue later">Sleep</button>
      <button class="ghost small" data-sp="close" title="End the session without an outcome">Close</button>`}
      <button class="ghost small" data-sp="hide" title="Hide the panel; the session keeps running (a tab on the right brings it back)">Hide ▸</button>
    </header>
    ${s.state === 'done' ? `<div class="sp-done">✓ Done: ${esc(s.outcome || 'closed')}. ${s.summary ? esc(s.summary) + '. This panel closes in a moment.' : 'Its transcript is on the Sessions page.'}</div>`
      : `${outs ? `<div class="sp-outcomes"><span class="muted">Outcome:</span> ${outs}</div>` : ''}<div class="sp-hint muted">First time in this vault, Claude asks if you trust the folder: pick "Yes, I trust this folder". Drag the left edge to resize.</div>`}`;
  }

  function paintHeader() {
    const p = el();
    const h = p.querySelector('.sp-head');
    if (h) h.innerHTML = header();
  }

  async function show(s) {
    cur = s;
    suggested = '';
    const p = el();
    p.hidden = false;
    document.body.classList.add('with-spanel');
    tab().hidden = true;
    // The log column and the session panel together squeeze the page: close the log.
    const d = document.getElementById('drawer');
    if (d && !d.hidden) { d.hidden = true; const lt = document.getElementById('log-toggle'); if (lt) lt.classList.remove('on'); }
    p.style.width = width();
    p.innerHTML = `<div class="sp-grip" title="Drag to resize"></div><div class="sp-head">${header()}</div><div id="sp-term"></div>`;
    grip(p.querySelector('.sp-grip'));
    if (ws) { try { ws.close(); } catch {} ws = null; }
    if (term) { term.dispose(); term = null; }
    term = new window.Terminal({ fontSize: 13, fontFamily: 'Menlo, monospace', cursorBlink: true, scrollback: 20000, theme: { background: '#141414' } });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener')));
    term.open(document.getElementById('sp-term'));
    setTimeout(() => fit.fit(), 0);
    if (s.state === 'done') { term.write('\x1b[90mThis session is done. Its transcript is on the Sessions page.\x1b[0m\r\n'); return; }
    if (!s.running) cur = (await api(`/api/sessions/${s.id}/open`, { method: 'POST', body: JSON.stringify({ cols: term.cols, rows: term.rows }) })).session || cur;
    paintHeader();
    ws = new WebSocket(`ws://${location.host}/?session=${s.id}&token=${encodeURIComponent(TOKEN)}`);
    let tail = '';
    ws.onmessage = (m) => {
      const j = JSON.parse(m.data);
      if (j.type === 'replay' || j.type === 'out') {
        term.write(j.data);
        tail = (tail + strip(j.data)).slice(-4000);
        const sg = [...tail.matchAll(/SUGGEST:\s*"?([^"\r\n]+?)"?\s*(\r|\n|$)/g)].pop();
        if (sg && (cur.outcomes || []).some((o) => o.label === sg[1].trim()) && suggested !== sg[1].trim()) { suggested = sg[1].trim(); paintHeader(); }
      }
      if (j.type === 'state') { cur = { ...cur, state: j.state, running: j.state === 'open', outcome: j.outcome || cur.outcome }; paintHeader(); onChange(); }
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    term.onData((d) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'in', data: d })); });
    term.onResize(({ cols, rows }) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
    window.addEventListener('resize', () => fit && fit.fit());
    term.focus();
    onChange();
  }

  async function onClick(ev) {
    const t = ev.target.closest('button');
    if (!t || !cur) return;
    if (t.dataset.outcome) {
      const label = t.dataset.outcome;
      if (!confirm(`${label}? The app does this now and closes the session.`)) return;
      t.disabled = true;
      const r = await api(`/api/sessions/${cur.id}/outcome`, { method: 'POST', body: JSON.stringify({ label }) });
      if (r.error) { alert(r.error); t.disabled = false; return; }
      cur = { ...r.session, summary: r.summary }; paintHeader();
      term.write(`\r\n\x1b[32m✓ ${r.summary}\x1b[0m\r\n`);
      const done = cur;
      setTimeout(() => { if (cur && cur.id === done.id) hide(); onDone(done); onChange(true); }, 1800);
      return;
    }
    const a = t.dataset.sp;
    if (a === 'hide') return hide();
    if (a === 'sleep' || a === 'close') {
      if (a === 'close' && !confirm('Close this session? It ends with no outcome; the item stays on Today.')) return;
      const r = await api(`/api/sessions/${cur.id}/${a}`, { method: 'POST', body: '{}' });
      if (r.session) cur = r.session;
      paintHeader(); onChange();
      if (a === 'close') { hide(); onDone(cur); }
    }
  }

  function hide() {
    const p = el();
    p.hidden = true;
    document.body.classList.remove('with-spanel');
    if (ws) { try { ws.close(); } catch {} ws = null; }
    const t = tab();
    t.hidden = !(cur && cur.state !== 'done');
    if (!t.hidden) t.textContent = `◂ ${cur.title}`;
  }

  // A hidden session that is still open: a tab on the right edge brings it back.
  function tab() {
    let t = document.getElementById('sp-tab');
    if (!t) {
      t = document.createElement('button');
      t.id = 'sp-tab'; t.hidden = true; t.title = 'Show the session';
      t.onclick = () => cur && show(cur);
      document.body.appendChild(t);
    }
    return t;
  }

  // Panel width: dragged by the owner, kept per browser.
  const W = 'brain.spw';
  function width() {
    let w = 0; try { w = Number(localStorage.getItem(W)) || 0; } catch {}
    return w ? `${Math.min(Math.max(w, 360), window.innerWidth - 420)}px` : '45%';
  }
  function grip(g) {
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const p = el();
      const move = (m) => { p.style.width = `${Math.min(Math.max(window.innerWidth - m.clientX, 360), window.innerWidth - 420)}px`; fit && fit.fit(); };
      const up = () => {
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
        document.body.classList.remove('sp-dragging');
        try { localStorage.setItem(W, String(parseInt(p.style.width, 10))); } catch {}
        fit && fit.fit();
      };
      document.body.classList.add('sp-dragging');
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  window.SessionPanel = {
    init(o) { api = o.api; esc = o.esc; onChange = o.onChange || (() => {}); onDone = o.onDone || (() => {}); },
    // Start (or reopen) the session for an item. The server builds it.
    async start(kind, item, model) {
      const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ kind, item, model }) });
      if (r.error) { alert(r.error); return; }
      await show(r.session);
    },
    async openId(id) {
      const r = await api('/api/sessions');
      const s = (r.sessions || []).find((x) => x.id === id);
      if (s) await show(s);
    },
    current: () => cur && !el().hidden ? cur.id : null,
  };
})();
