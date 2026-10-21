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
  // Make me better's Apply, Undo and Discard, in a strip under the header.
  // The server says what to show (GET /api/improve/progress); ask and note
  // are this tab's own: an "are you sure" step, and a one-line result.
  let prog = null, ask = null, note = null, pollT = null, baseline = null;
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
      ${s.state === 'done' ? '' : s.kind === 'improve' ? `<button class="small ${busy() ? 'ghost' : ''}" data-sp="apply" ${busy() ? 'disabled' : ''} title="Test this change, then switch the app to it. If the app does not come back, it goes back by itself.">${busy() ? 'Applying…' : 'Apply'}</button>
      <button class="ghost small" data-sp="discard" title="Throw away the changes the app does not run yet">Discard</button>
      <button class="ghost small" data-sp="undo" title="Go back to the version before the last Apply">Undo last Apply</button>
      <button class="ghost small" data-sp="sleep" title="Stop the process; keep the session to continue later">Sleep</button>
      <button class="ghost small" data-sp="close" title="End the session. The dev copy keeps its work.">Close</button>` : `<button class="ghost small" data-sp="sleep" title="Stop the process; keep the session to continue later">Sleep</button>
      <button class="ghost small" data-sp="close" title="End the session. Nothing is saved to the vault.">Close</button>
      <button class="ghost small" data-sp="save" title="End the session and save it to the vault (projects/sessions/). The next ingest picks it up.">Save &amp; close</button>`}
      <button class="ghost small" data-sp="hide" title="Hide the panel; the session keeps running (a tab on the right brings it back)">Hide ▸</button>
    </header>
    ${s.kind === 'improve' && s.state !== 'done' ? applyStrip() : ''}
    ${s.state === 'done' ? `<div class="sp-done">✓ Done: ${esc(s.outcome || 'closed')}. ${s.summary ? esc(s.summary) + '. This panel closes in a moment.' : 'Its transcript is on the Sessions page.'}</div>`
      : `${outs ? `<div class="sp-outcomes"><span class="muted">Outcome:</span> ${outs}</div>` : ''}<div class="sp-hint muted">${s.kind === 'improve' ? 'This session works in your own copy of the app, not in the app you use. Nothing changes until you press Apply. The first time, Claude asks if you trust the folder: pick "Yes, I trust this folder".' : 'First time in this vault, Claude asks if you trust the folder: pick "Yes, I trust this folder".'} Drag the left edge to resize.</div>`}`;
  }

  function paintHeader() {
    const p = el();
    const h = p.querySelector('.sp-head');
    if (h) h.innerHTML = header();
    if (fit) setTimeout(() => fit && fit.fit(), 0); // the strip changes the header's height
  }

  const busy = () => { const st = prog && prog.view && prog.view.state; return st === 'running' || st === 'switching'; };
  function since(iso) {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
  }
  const list = (xs) => `<ul>${xs.slice(0, 12).map((x) => `<li><code>${esc(x)}</code></li>`).join('')}${xs.length > 12 ? `<li class="muted">and ${xs.length - 12} more</li>` : ''}</ul>`;

  // One strip for Apply, Undo and Discard. Each state says what happens now
  // and what the owner can do; nothing hides in the log or in a popup.
  function applyStrip() {
    if (ask) return `<div class="sp-apply ask">${esc(ask.text)}<div class="row"><button class="small" data-sp="ask-yes">${esc(ask.yes)}</button><button class="ghost small" data-sp="ask-no">Cancel</button></div></div>`;
    if (note) return `<div class="sp-apply ${note.kind}">${esc(note.text)}<div class="row"><button class="ghost small" data-sp="note-close">Close</button></div></div>`;
    const v = prog && prog.view;
    if (!v) return '';
    if (v.state === 'running') {
      return `<div class="sp-apply run"><b>Apply: ${esc(v.step.label)}</b> <span class="muted">· ${since(v.startedAt)} so far</span>
        <div class="muted sm">${esc(v.line || '')}</div>
        <div class="muted sm">Do not change the dev copy until this ends. Bots and the Morning run wait until then.</div></div>`;
    }
    if (v.state === 'switching') return `<div class="sp-apply run"><b>${esc(v.step.label)}.</b> This page reloads when the app is back. If the new code does not come back, the app goes back by itself.</div>`;
    if (v.state === 'waiting') {
      return `<div class="sp-apply ask"><b>Waiting for you.</b> The tests in the dev copy pass. This change touches the guard rails, so check these before it goes on:
        ${v.guards.length ? `<div class="sm">Rules, tests or safety code it changes:</div>${list(v.guards)}` : ''}
        ${v.trustedFailures.length ? `<div class="sm">Tests your app trusted until now that fail with this change:</div>${list(v.trustedFailures)}` : ''}
        ${v.canConfirm ? '' : '<div class="sm">The dev copy changed after this check. Press Apply again to check the new version.</div>'}
        <div class="row">${v.canConfirm ? '<button class="small" data-sp="apply-confirm">Confirm and apply</button>' : '<button class="small" data-sp="apply">Apply again</button>'}<button class="ghost small" data-sp="apply-dismiss">Cancel</button></div></div>`;
    }
    if (v.state === 'error') {
      return `<div class="sp-apply bad"><b>Apply stopped. Nothing was switched.</b> ${esc(v.summary || '')}
        ${v.failures.length ? `<div class="sm">What failed:</div>${list(v.failures)}` : ''}
        <div class="row"><button class="small" data-sp="apply-fix" title="Puts the error in the session's prompt. Press Enter there to send it.">Ask the session to fix it</button><button class="ghost small" data-sp="apply-dismiss">Close</button></div></div>`;
    }
    if (v.state === 'stopped') return `<div class="sp-apply bad"><b>Apply stopped.</b> ${esc(v.summary || '')}<div class="row"><button class="ghost small" data-sp="apply-dismiss">Close</button></div></div>`;
    return '';
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
    if (/^(apply|apply-confirm|apply-dismiss|apply-fix|discard|undo|ask-yes|ask-no|note-close)$/.test(a)) return improveAction(a);
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
    if (a === 'ask-no') { ask = null; return paintHeader(); }
    if (a === 'note-close') { note = null; return paintHeader(); }
    if (a === 'ask-yes') { const x = ask; ask = null; paintHeader(); return x.run(); }
    if (a === 'discard') { note = null; ask = { text: 'Throw away every change in the dev copy that the app does not run yet? This cannot be undone.', yes: 'Discard', run: discard }; return paintHeader(); }
    if (a === 'undo') { note = null; ask = { text: 'Go back to the version before the last Apply? The app restarts.', yes: 'Undo', run: undo }; return paintHeader(); }
    if (a === 'apply') return startApply({});
    if (a === 'apply-confirm') return startApply({ confirm: prog.view.sha });
    if (a === 'apply-dismiss') { prog = await api('/api/improve/apply/dismiss', { method: 'POST', body: '{}' }); return paintHeader(); }
    if (a === 'apply-fix') {
      const v = prog.view;
      const text = `Apply stopped: ${v.summary || ''}${v.failures.length ? ` What failed: ${v.failures.slice(0, 12).join('; ')}.` : ''} Find the cause and fix it. Do not weaken a test.`;
      if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'in', data: text.replace(/[\r\n]+/g, ' ') })); term.focus(); }
    }
  }

  async function startApply(body) {
    note = null;
    baseline = await aliveAt();
    const r = await api('/api/improve/apply', { method: 'POST', body: JSON.stringify(body) });
    if (r.progress) prog = r.progress;
    if (r.error && !(r.progress && r.progress.view.state !== 'idle')) note = { kind: 'bad', text: r.error };
    paintHeader(); onChange();
    follow();
  }
  async function undo() {
    baseline = await aliveAt();
    const r = await api('/api/improve/undo', { method: 'POST', body: '{}' });
    if (r.error || r.status === 'error') { note = { kind: 'bad', text: r.error || r.summary }; return paintHeader(); }
    follow();
  }
  async function discard() {
    const r = await api('/api/improve/discard', { method: 'POST', body: '{}' });
    note = r.error ? { kind: 'bad', text: r.error } : { kind: 'ok', text: `Discarded ${r.discarded} change(s). The dev copy matches the app again.` };
    paintHeader(); onChange();
  }

  // The server's start time: it changes when the app restarts on new code.
  async function aliveAt() {
    try { const j = await (await fetch('/alive')).json(); return j.brain ? j.startedAt : null; } catch { return null; }
  }

  // Follow Apply or Undo: poll the server every 2 s while it runs or
  // switches. A restart (a new start time) reloads the page; after the
  // reload, init() follows on until apply.json says how it ended, so a
  // rollback also shows. The server may be down for a moment mid-switch.
  function follow() {
    if (pollT) return;
    const tick = async () => {
      pollT = null;
      let r = null;
      try { r = await api('/api/improve/progress'); } catch {}
      if (r && r.view) { prog = r; paintHeader(); }
      const st = prog && prog.view && prog.view.state;
      if (st === 'switching') {
        const now = await aliveAt();
        if (now && baseline && now !== baseline) return location.reload();
        if (now && !baseline) baseline = now;
      }
      if (!r || st === 'running' || st === 'switching') { pollT = setTimeout(tick, 2000); return; }
      onChange();
      showBanner(r.banner);
    };
    pollT = setTimeout(tick, 500);
  }

  // How the last Apply or Undo ended, once, at the top of the page.
  function showBanner(b) {
    if (!b) return;
    let seen = ''; try { seen = localStorage.getItem('brain.applySeen') || ''; } catch {}
    if (seen === b.at) return;
    let d = document.getElementById('apply-banner');
    if (!d) { d = document.createElement('div'); d.id = 'apply-banner'; document.body.appendChild(d); }
    d.className = b.kind;
    d.innerHTML = `<span>${esc(b.text)}</span><button class="ghost small" title="Close">✕</button>`;
    d.querySelector('button').onclick = () => { try { localStorage.setItem('brain.applySeen', b.at); } catch {} d.remove(); };
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
      // After a restart or in a second tab: show how the last Apply or Undo
      // ended, and follow one that still runs or switches.
      api('/api/improve/progress').then(async (r) => {
        if (!r || !r.view) return;
        prog = r;
        if (busy()) { baseline = await aliveAt(); follow(); } else showBanner(r.banner);
        paintHeader();
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
