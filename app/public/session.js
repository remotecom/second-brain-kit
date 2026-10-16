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
  let applying = false;
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
      <div class="sp-title"><span class="dot ${s.running ? 'running' : 'never'}"></span><b class="sp-name" data-sp="rename" title="Rename">${esc(s.title)}</b> <span class="muted">${esc(s.model)} · ${esc(s.state)}</span></div>
      <span class="spacer"></span>
      ${s.state === 'done' ? '' : s.kind === 'improve' ? `<button class="small ${applying ? 'ghost' : ''}" data-sp="apply" ${applying ? 'disabled' : ''} title="Test this change, then switch the app to it. If the app does not come back, it goes back by itself.">${applying ? 'Applying…' : 'Apply'}</button>
      <button class="ghost small" data-sp="discard" title="Throw away the changes the app does not run yet">Discard</button>
      <button class="ghost small" data-sp="undo" title="Go back to the version before the last Apply">Undo last Apply</button>
      <button class="ghost small" data-sp="sleep" title="Stop the process; keep the session to continue later">Sleep</button>
      <button class="ghost small" data-sp="close" title="End the session. The dev copy keeps its work.">Close</button>` : `<button class="ghost small" data-sp="sleep" title="Stop the process; keep the session to continue later">Sleep</button>
      <button class="ghost small" data-sp="close" title="End the session. Nothing is saved to the vault.">Close</button>
      <button class="ghost small" data-sp="save" title="End the session and save it to the vault (projects/sessions/). The next ingest picks it up.">Save &amp; close</button>`}
      <button class="ghost small" data-sp="hide" title="Hide the panel; the session keeps running (a tab on the right brings it back)">Hide ▸</button>
    </header>
    ${s.state === 'done' ? `<div class="sp-done">✓ Done: ${esc(s.outcome || 'closed')}. ${s.summary ? esc(s.summary) + '. This panel closes in a moment.' : 'Its transcript is on the Sessions page.'}</div>`
      : `${outs ? `<div class="sp-outcomes"><span class="muted">Outcome:</span> ${outs}</div>` : ''}<div class="sp-hint muted">${s.kind === 'improve' ? 'This session works in your own copy of the app, not in the app you use. Nothing changes until you press Apply. The first time, Claude asks if you trust the folder: pick "Yes, I trust this folder".' : 'First time in this vault, Claude asks if you trust the folder: pick "Yes, I trust this folder".'} Drag the left edge to resize.</div>`}`;
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
    // Plain URLs and Claude's OSC 8 hyperlinks both open through the server
    // (/api/brain/open), in a normal browser tab. window.open from this --app
    // window made an app window with no tabs or URL bar.
    term.options.linkHandler = { activate: (e, uri) => window.openLink(uri), allowNonHttpProtocols: false };
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon((e, uri) => window.openLink(uri)));
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
    // xterm sends a bare CR for Shift+Enter, so Claude submits the prompt.
    // ESC+CR is the newline that Claude Code's /terminal-setup binds. Cancel
    // the event too: if not, the browser fires keypress and xterm sends a CR
    // as well (newline AND submit). From briefcase/public/app.js.
    term.attachCustomKeyEventHandler((e) => {
      const stop = () => { e.preventDefault(); e.stopPropagation(); return false; };
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.type === 'keydown' && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'in', data: '\x1b\r' }));
        return stop();
      }
      // claude is the direct child of the pty, with no shell to bring it back:
      // Ctrl+Z would stop it and the panel would hang.
      if (e.type === 'keydown' && e.key === 'z' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return stop();
      return true;
    });
    term.onResize(({ cols, rows }) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
    window.addEventListener('resize', () => fit && fit.fit());
    term.focus();
    onChange();
  }

  async function onClick(ev) {
    const t = ev.target.closest('button, [data-sp="rename"]');
    if (!t || !cur) return;
    if (t.dataset.sp === 'rename') {
      const name = prompt('Rename this session', cur.title);
      if (!name || name.trim() === cur.title) return;
      const r = await api(`/api/sessions/${cur.id}/rename`, { method: 'POST', body: JSON.stringify({ title: name }) });
      if (r.error) { alert(r.error); return; }
      cur = r.session; paintHeader(); onChange();
      return;
    }
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
    if (a === 'apply' || a === 'discard' || a === 'undo') return improveAction(a);
    if (a === 'sleep' || a === 'close' || a === 'save') {
      if (a === 'close' && !confirm('Close this session? Nothing is saved to the vault. Its transcript stays on the Sessions page.')) return;
      if (a === 'save' && !confirm('Save this session to the vault and close it?\n\nIt goes to projects/sessions/ as raw, word for word (credentials redacted). The next ingest folds it into the wiki.')) return;
      const r = await api(`/api/sessions/${cur.id}/${a === 'sleep' ? 'sleep' : 'close'}`, { method: 'POST', body: JSON.stringify(a === 'save' ? { save: true } : {}) });
      if (r.error) { alert(r.error); return; }
      if (r.session) cur = r.session;
      paintHeader(); onChange();
      if (a === 'save' && r.saved) {
        const sv = r.saved;
        alert(sv.error ? `Closed, but not saved: ${sv.error}.`
          : `Saved to ${sv.written.length ? sv.written.join(', ') : 'the vault (no change since the last save)'}${sv.secrets ? ` (${sv.secrets} credential(s) redacted)` : ''}. The next ingest folds it into the wiki.`);
      }
      if (a !== 'sleep') { hide(); onDone(cur); }
    }
  }

  // Make me better: the app (not the model) applies, discards and undoes.
  async function improveAction(a) {
    if (a === 'discard') {
      if (!confirm('Throw away every change in the dev copy that the app does not run yet? This cannot be undone.')) return;
      const r = await api('/api/improve/discard', { method: 'POST', body: '{}' });
      return alert(r.error ? r.error : `Discarded ${r.discarded} change(s). The dev copy matches the app again.`);
    }
    if (a === 'undo') {
      if (!confirm('Go back to the version before the last Apply? The app restarts.')) return;
      const r = await api('/api/improve/undo', { method: 'POST', body: '{}' });
      if (r.error || r.status === 'error') return alert(r.error || r.summary);
      return waitForRestart(r.summary);
    }
    if (!confirm('Apply this change? The app runs the tests and starts the new code on the side first (about 2-4 minutes; the log shows each step). Then it switches over and restarts.')) return;
    applying = true; paintHeader(); onChange(true);
    let r = await api('/api/improve/apply', { method: 'POST', body: '{}' });
    if (r.status === 'confirm') {
      const lines = [
        'This change touches the guard rails. Check these before you go on.',
        ...(r.guards.length ? ['', 'Rules, tests or safety code it changes:', ...r.guards.map((g) => `  • ${g}`)] : []),
        ...(r.trustedFailures.length ? ['', 'Tests your app trusted until now that fail with this change:', ...r.trustedFailures.map((g) => `  • ${g}`)] : []),
        '', 'Apply anyway?',
      ];
      if (!confirm(lines.join('\n'))) { applying = false; paintHeader(); return; }
      r = await api('/api/improve/apply', { method: 'POST', body: JSON.stringify({ confirm: r.sha }) });
    }
    applying = false; paintHeader();
    if (r.error || r.status === 'error') return alert(`${r.error || r.summary}${r.failures && r.failures.length ? `\n\n${r.failures.slice(0, 12).join('\n')}` : ''}`);
    if (r.status === 'switching') return waitForRestart(r.summary);
  }

  // The app restarts on the new code: wait for a new process, then reload.
  async function waitForRestart(msg) {
    alert(`${msg}\n\nThis page reloads when the app is back.`);
    let first = null;
    try { first = (await (await fetch('/alive')).json()).startedAt; } catch {}
    for (let i = 0; i < 90; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      try { const j = await (await fetch('/alive')).json(); if (j.startedAt !== first && j.brain) return location.reload(); } catch {}
    }
    location.reload();
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
    init(o) {
      api = o.api; esc = o.esc; onChange = o.onChange || (() => {}); onDone = o.onDone || (() => {});
      // After a restart: say once how the last Apply or Undo ended.
      api('/api/improve').then((st) => {
        const l = st && st.last;
        if (!l || !l.mode || l.state === 'switching') return;
        let seen = ''; try { seen = localStorage.getItem('brain.applySeen') || ''; } catch {}
        if (seen === l.at) return;
        try { localStorage.setItem('brain.applySeen', l.at); } catch {}
        if (l.state === 'rolled-back') alert(`The last ${l.mode === 'undo' ? 'Undo' : 'Apply'} did not work, so the app went back to ${String(l.from).slice(0, 7)}.\n\nWhy: ${l.reason}\n\nYour change is still in the dev copy. Open Make me better to fix it.`);
        else if (l.state === 'applied') alert(`${l.mode === 'undo' ? 'Undo' : 'Apply'} worked: the app now runs ${String(l.to).slice(0, 7)}.`);
      }).catch(() => {});
    },
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
