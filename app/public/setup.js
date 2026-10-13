// The Setup page: eight steps, top to bottom. Each probe presses connector
// buttons through the app (the code reads the answers); each Save writes
// config.yaml and keeps your comments. Mounted once per visit, so the board's
// polling never resets what you are typing.
(() => {
  let ctx = null;   // { api, esc, onChange }
  let view = null;  // GET /api/setup
  let root = null;
  const busy = {};
  const picks = {}; // per-step unsaved choices

  const esc = (s) => ctx.esc(s);
  const STEP = {
    connectors: 'Connectors', identity: 'You', scope: 'Linear scope', privacy: 'Privacy',
    schedule: 'Schedule', obsidian: 'Obsidian', 'first-run': 'First run', 'wiki-shape': 'Wiki shape',
  };
  const SRC = { slack: 'Slack', linear: 'Linear', notion: 'Notion', gcal: 'Google Calendar', gdrive: 'Google Drive' };

  let shape = null;  // GET /api/setup/shape
  async function load() { [view, shape] = await Promise.all([ctx.api('/api/setup'), ctx.api('/api/setup/shape')]); paint(); }

  async function probe(step) {
    busy[step] = true; paint();
    const r = await ctx.api('/api/setup/probe', { method: 'POST', body: JSON.stringify({ step }) });
    busy[step] = false;
    if (r.error) alert(r.fix ? `${r.error}\n\n${r.fix}` : r.error);
    if (r.view) view = r.view;
    picks[step] = null;
    paint(); ctx.onChange();
  }

  async function save(step, values) {
    busy[step] = true; paint();
    const r = await ctx.api('/api/setup/save', { method: 'POST', body: JSON.stringify({ step, values }) });
    busy[step] = false;
    if (r.error) alert(r.error); else { view = r.view; picks[step] = null; }
    paint(); ctx.onChange();
  }

  // --- steps ---
  function connectors() {
    const pr = (view.probes.connectors || {}).sources;
    const cur = view.current;
    const rows = Object.keys(SRC).map((k) => {
      const p = pr && pr[k];
      const chosen = (picks.connectors && picks.connectors[k]) || (p && p.chosen) || cur.connectors[k];
      const cands = p ? p.candidates : [];
      const choice = cands.length > 1
        ? cands.map((c) => `<label class="opt"><input type="radio" name="c-${k}" value="${esc(c.prefix)}" ${c.prefix === chosen ? 'checked' : ''} data-conn="${k}"> ${esc(c.prefix)} <span class="pill ${c.status === 'ok' ? 'ok' : 'error'}">${esc(c.status)}</span></label>`).join('')
        : `<code>${esc(chosen || '—')}</code>`;
      const st = !p ? '<span class="muted">not checked</span>'
        : !cands.length && p.connecting ? '<span class="pill warn">still connecting: Find again</span>'
        : !cands.length ? '<span class="pill error">not connected</span>'
          : p.ambiguous ? '<span class="pill warn">pick one</span>'
            : cands.some((c) => c.status === 'ok') ? '<span class="pill ok">ok</span>' : '<span class="pill error">not logged in</span>';
      return `<tr><td><label><input type="checkbox" data-enable="${k}" ${cur.enabled[k] ? 'checked' : ''}> ${SRC[k]}</label></td><td>${choice}</td><td>${st}</td></tr>`;
    }).join('');
    const missing = pr && Object.keys(SRC).filter((k) => cur.enabled[k] && !(pr[k].candidates || []).some((c) => c.status === 'ok'));
    return `<p>The bots reach your sources through the claude.ai connectors on your account. Tool names differ per account, so the app finds them.</p>
      <table class="t"><thead><tr><th>Source (on/off)</th><th>Connector</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
      ${missing && missing.length ? `<p class="warn">Not working: ${missing.map((k) => SRC[k]).join(', ')}. Open claude.ai → Settings → Connectors, connect them, then press Find again. Or turn them off.</p>` : ''}
      <div class="row"><button class="small" data-probe="connectors">${pr ? 'Find again' : 'Find my connectors'}</button>
      <button class="small" data-save="connectors">Save</button><a class="small ghost" href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">claude.ai connectors ↗</a></div>`;
  }

  function identity() {
    const pr = view.probes.identity || {};
    const o = view.current.owner;
    const val = (k, d) => esc((picks.identity && picks.identity[k]) ?? (o[k] && !/X{4,}|^Your Name$|@example\.com$/.test(o[k]) ? o[k] : d || ''));
    const slackOpts = (pr.slack || []).map((id) => `<option value="${esc(id)}">`).join('');
    const notionOpts = (pr.notion || []).map((u) => `<option value="${esc(u.id)}">${esc(u.name)} ${esc(u.email)}</option>`).join('');
    return `<p>Who you are in each source. The syncs use this to find your own messages, pages and issues.</p>
      <div class="form">
        <label>Name <input data-f="name" value="${val('name', pr.name)}" placeholder="as people write it"></label>
        <label>Work email <input data-f="email" value="${val('email', pr.email)}"></label>
        <label>Time zone <input data-f="timezone" value="${val('timezone', pr.timezone)}" placeholder="America/New_York"></label>
        <label>Slack member ID <input data-f="slack_user_id" list="slack-ids" value="${val('slack_user_id', pr.slackId)}" placeholder="U0…"><datalist id="slack-ids">${slackOpts}</datalist></label>
        <label>Notion user ID <input data-f="notion_user_id" list="notion-ids" value="${val('notion_user_id', pr.notionId)}"><datalist id="notion-ids">${notionOpts}</datalist></label>
      </div>
      <div class="row"><button class="small ghost" data-probe="identity">Look me up</button><button class="small" data-save="identity">Save</button></div>`;
  }

  function scope() {
    const pr = view.probes.scope;
    const cur = view.current.scope || {};
    const p = picks.scope || { type: cur.team ? 'team' : 'initiative', q: '', id: cur.initiative || cur.team || '' };
    picks.scope = p;
    let list = '';
    if (pr) {
      const q = p.q.toLowerCase();
      const items = p.type === 'team'
        ? pr.teams.map((t) => ({ id: t.key, label: `${t.name} (${t.key})`, sub: '' }))
        : pr.initiatives.map((i) => ({ id: i.id, label: i.name, sub: i.status }));
      const shown = items.filter((x) => !q || x.label.toLowerCase().includes(q)).slice(0, 60);
      list = `<div class="pick">${shown.map((x) => `<div class="pick-row ${x.id === p.id ? 'sel' : ''}" data-scope="${esc(x.id)}">${esc(x.label)} <span class="muted">${esc(x.sub)}</span></div>`).join('') || '<div class="muted">Nothing matches.</div>'}</div>`;
    }
    return `<p>Which Linear work the sync covers: one initiative (with all its sub-initiatives and projects) or one team.</p>
      <div class="row"><label class="opt"><input type="radio" name="st" value="initiative" ${p.type === 'initiative' ? 'checked' : ''} data-stype> Initiative</label>
      <label class="opt"><input type="radio" name="st" value="team" ${p.type === 'team' ? 'checked' : ''} data-stype> Team</label>
      ${pr ? `<input data-sq placeholder="Search ${p.type === 'team' ? 'teams' : 'initiatives'}" value="${esc(p.q)}">` : ''}</div>
      ${list}
      <div class="n">Now: ${cur.initiative ? `initiative <code>${esc(cur.initiative)}</code>` : cur.team ? `team <code>${esc(cur.team)}</code>` : 'not set'}</div>
      <div class="row"><button class="small ghost" data-probe="scope">${pr ? 'Load again' : 'Load from Linear'}</button>
      <button class="small" data-save="scope" ${p.id ? '' : 'disabled'}>Save</button>
      <button class="small ghost" data-rescope ${busy.rescope ? 'disabled' : ''}>${busy.rescope ? 'Rescope started: see the Log, then Today' : 'Run Linear rescope'}</button></div>
      <div class="n">After you change the scope, run the rescope. The first one asks you to confirm the project count.</div>`;
  }

  function privacy() {
    const pr = view.probes.privacy;
    if (!pr) return `<p>See exactly what would sync before anything does: every calendar your account can read, and every top-level Drive folder. Nothing is fetched beyond the names.</p>
      <div class="row"><button class="small" data-probe="privacy">Show the preview</button></div>`;
    const p = picks.privacy || { cal: Object.fromEntries(pr.calendars.map((c) => [c.id, c.on])), fol: Object.fromEntries(pr.folders.map((f) => [f.id, f.on])) };
    picks.privacy = p;
    const miss = pr.missing || [];
    const group = (title, key, items, lost) => `<div class="grp"><div class="grp-h">${title} <button class="tiny ghost" data-all="${key}">All</button><button class="tiny ghost" data-none="${key}">None</button></div>
      ${lost ? '<div class="warn-t">The connector did not answer, so this list is not known yet. Press Refresh. Saving keeps what config.yaml has now.</div>' : items.map((x) => `<label class="opt line"><input type="checkbox" data-pv="${key}" value="${esc(x.id)}" ${p[key][x.id] ? 'checked' : ''} ${x.locked ? 'disabled' : ''}> ${esc(x.name)}${x.locked ? ' <span class="muted">(always excluded)</span>' : ''}</label>`).join('') || '<div class="muted">none</div>'}</div>`;
    return `<p>Ticked = synced. Start with your own work calendar only: other calendars can be personal or a colleague's. Drive syncs files you own or edited, except in unticked folders.</p>
      ${group('Calendars', 'cal', pr.calendars, miss.includes('calendars'))}${group('Top-level Drive folders', 'fol', pr.folders, miss.includes('drive folders'))}
      <div class="row"><button class="small ghost" data-probe="privacy">Refresh</button><button class="small" data-save="privacy">Save</button></div>`;
  }

  function schedule() {
    const c = view.current;
    const p = picks.schedule || { morning_at: c.schedule.morning_at, usage_share: c.usage_share, enabled: c.schedule.enabled };
    picks.schedule = p;
    const share = { light: 'about 25% of a day', normal: 'about 40%', heavy: 'about 60%' };
    return `<p>The Morning run syncs everything, folds it into the wiki and checks it, once a day. It starts again after a restart when the app runs at login (setup adds that).</p>
      <div class="form"><label>Morning run at <input type="time" data-sch="morning_at" value="${esc(p.morning_at)}"></label>
      <label class="opt"><input type="checkbox" data-sch="enabled" ${p.enabled ? 'checked' : ''}> Run every morning</label></div>
      <div class="n">Usage share: the bots use your claude.ai plan and share its limits with you. No per-call charge.</div>
      <div class="row">${Object.keys(share).map((k) => `<label class="opt"><input type="radio" name="us" value="${k}" ${p.usage_share === k ? 'checked' : ''} data-share> ${k} <span class="muted">(${share[k]})</span></label>`).join('')}</div>
      <div class="row"><button class="small" data-save="schedule">Save</button></div>`;
  }

  function obsidian() {
    if (!view.obsidianInstalled) return `<p>Obsidian is optional. It shows the wiki as a graph. Install it from <a href="https://obsidian.md" target="_blank" rel="noopener">obsidian.md</a> (or run the installer again), then come back to this step.</p>`;
    const vid = view.obsidianVaultId || view.vaultName;
    return `<p>Open the vault in Obsidian for the graph view. Apply adds this vault to Obsidian and sets the graph to show the wiki only, one color per section, with the index, the log and the raw sources hidden. Your own color groups stay.</p>
      ${view.obsidianRunning ? '<p class="warn">Obsidian is open. Close it, then press Apply (it rewrites its files when it quits).</p>' : ''}
      <div class="row"><button class="small" data-graph ${view.obsidianRunning ? 'disabled' : ''}>Apply graph colors</button>
      ${view.obsidianVaultId || view.obsidianRunning ? `<a class="small ghost" href="obsidian://open?vault=${encodeURIComponent(vid)}">Open in Obsidian</a>` : ''}</div>`;
  }

  function firstRun() {
    const c = view.current;
    if (view.firstRunStarted) return `<p>The first run has started. From now on the Morning run starts by itself at ${esc(c.schedule.morning_at)}.</p>`;
    const p = picks['first-run'] || { days: c.bootstrap_days || 7 };
    picks['first-run'] = p;
    return `<p>The first run syncs your sources and back-fills history once; then each day takes only what is new. A longer window takes longer and uses more of your plan. 3 days is a quick trial. The first ingest waits for your wiki shape (the next step), so the shape can be suggested from this data.</p>
      <div class="row">${[3, 7, 14, 30].map((d) => `<label class="opt"><input type="radio" name="bd" value="${d}" ${Number(p.days) === d ? 'checked' : ''} data-bd> ${d} days</label>`).join('')}</div>
      <div class="row"><button class="small" data-first>Start the first run</button></div>
      <div class="n">It runs in the background. Follow it in the Log, and find the result on Today.</div>`;
  }

  // --- wiki shape: the sections the wiki is built around ---
  function wikiShape() {
    if (!shape) return '<div class="muted">Loading…</div>';
    const d = picks.shape || (shape.draft ? { ...shape.draft, sections: shape.draft.sections.map((x) => ({ ...x })), tags: [...shape.draft.tags] } : null);
    picks.shape = d;
    const role = picks.role ?? shape.role ?? '';
    const applied = shape.appliedAt || shape.firstIngestDone;
    const head = `<p>The wiki gets one folder per kind of thing you work with (accounts, services, partners…), and one page per item. Pick the kinds before the first ingest. You can start from a preset, let Claude suggest them from your synced data, or talk it through. You can add sections later.</p>
      <div class="form"><label>What do you do? <input data-role value="${esc(role)}" placeholder="e.g. solutions engineer for partner integrations"></label></div>
      <div class="row"><span class="muted">Start from:</span> ${Object.entries(shape.presets).map(([id, p]) => `<button class="small ghost" data-preset="${esc(id)}" title="${esc(p.sections.join(', '))}">${esc(p.label)}</button>`).join('')}</div>
      <div class="row"><button class="small" data-suggest ${busy.suggest ? 'disabled' : ''}>${busy.suggest ? 'Reading your data…' : 'Suggest from my data'}</button>
      <button class="small ghost" data-shape-session title="A Claude Code session that reads a sample of your data and agrees the sections with you">Talk it through</button>
      <span class="muted">Suggest reads names and titles only (Sonnet, a few cents).</span></div>`;
    const cur = applied ? `<div class="n">Now: ${shape.current.sections.map((x) => `<code>${esc(x.name)}</code>${shape.counts[x.name] ? ` <span class="muted">${shape.counts[x.name]}</span>` : ''}`).join(' ')}</div>` : '';
    if (!d) return head + cur;
    const rows = d.sections.map((x, i) => `<div class="shape-row"><input data-sn="${i}" value="${esc(x.name)}" placeholder="folder"><input data-snote="${i}" value="${esc(x.note)}" placeholder="what goes in it"><button class="tiny ghost" data-sdel="${i}" title="Remove" ${shape.counts[x.name] ? 'disabled' : ''}>✕</button>${x.why ? `<div class="muted why">${esc(x.why)}</div>` : ''}</div>`).join('');
    return `${head}${cur}
      <div class="grp"><div class="grp-h">Draft${d.from ? ` <span class="muted">(${esc(d.from)})</span>` : ''}</div>${d.summary ? `<div class="n">${esc(d.summary)}</div>` : ''}
      ${rows}<div class="row"><button class="tiny ghost" data-sadd>+ Add section</button></div>
      <label class="form">Tag namespaces <input data-stags value="${esc(d.tags.join(', '))}"></label></div>
      <div class="row"><button class="small" data-shape-apply>${shape.needsShape && view.firstRunStarted ? 'Use this shape and start the first ingest' : 'Use this shape'}</button></div>`;
  }

  async function shapeCall(url, body) {
    const r = await ctx.api(url, { method: 'POST', body: JSON.stringify(body) });
    if (r.error) { alert(r.error); return null; }
    if (r.view) shape = r.view;
    picks.shape = null;
    return r;
  }

  const BODY = { connectors, identity, scope, privacy, schedule, obsidian, 'first-run': firstRun, 'wiki-shape': wikiShape };

  // A vault that ingested before this step existed already has its shape.
  const isDone = (s) => view.done[s] || (s === 'first-run' && view.firstRunStarted) || (s === 'wiki-shape' && shape && !shape.needsShape);

  function paint() {
    if (!root || !view) return;
    const keepY = root.scrollTop;
    root.innerHTML = `<h1>Setup</h1><div class="sub">Eight steps. Each one saves on its own; come back any time.</div>
      ${view.steps.map((s, i) => `<div class="card step ${isDone(s) ? 'done' : ''}">
        <div class="k">${i + 1}. ${STEP[s]}${isDone(s) ? ' <span class="pill ok">done</span>' : ''}${busy[s] ? ' <span class="pill running">working…</span>' : ''}</div>
        ${BODY[s]()}</div>`).join('')}`;
    root.scrollTop = keepY;
  }

  function collectStep(step) {
    if (step === 'connectors') {
      const out = {};
      for (const k of Object.keys(SRC)) {
        const r = root.querySelector(`input[name="c-${k}"]:checked`);
        const pr = (view.probes.connectors || {}).sources;
        const prefix = r ? r.value : pr && pr[k] && pr[k].chosen;
        out[k] = { enabled: root.querySelector(`[data-enable="${k}"]`).checked, ...(prefix ? { prefix } : {}) };
      }
      return out;
    }
    if (step === 'identity') return Object.fromEntries([...root.querySelectorAll('[data-f]')].map((i) => [i.dataset.f, i.value]));
    if (step === 'scope') return picks.scope.type === 'team' ? { team: picks.scope.id } : { initiative: picks.scope.id };
    if (step === 'privacy') {
      const p = picks.privacy;
      const miss = (view.probes.privacy || {}).missing || [];
      // A list that never came back saves nothing: config.yaml keeps its value.
      return { ...(miss.includes('calendars') ? {} : { calendars: Object.keys(p.cal).filter((k) => p.cal[k]) }), ...(miss.includes('drive folders') ? {} : { excludeFolders: Object.keys(p.fol).filter((k) => !p.fol[k]) }) };
    }
    if (step === 'schedule') return picks.schedule;
    return {};
  }

  function onClick(ev) {
    const t = ev.target;
    const d = t.dataset || {};
    if (d.probe) return probe(d.probe);
    if (d.save) return save(d.save, collectStep(d.save));
    if (t.closest('[data-scope]')) { picks.scope.id = t.closest('[data-scope]').dataset.scope; return paint(); }
    if (d.all || d.none) { const key = d.all || d.none; const pr = view.probes.privacy; const items = key === 'cal' ? pr.calendars : pr.folders; for (const x of items) if (!x.locked) picks.privacy[key][x.id] = !!d.all; return paint(); }
    if ('rescope' in d) { busy.rescope = true; paint(); return ctx.api('/api/brain/bots/rescope/run', { method: 'POST', body: '{}' }).then((r) => { if (r.error) { alert(r.error); busy.rescope = false; paint(); } ctx.onChange(true); }); }
    if (d.preset) return shapeCall('/api/setup/shape/draft', { preset: d.preset, role: picks.role ?? shape.role }).then(paint);
    if ('suggest' in d) { busy.suggest = true; busy['wiki-shape'] = true; paint(); return shapeCall('/api/setup/shape/suggest', { role: picks.role ?? shape.role }).then(() => { busy.suggest = false; busy['wiki-shape'] = false; paint(); }); }
    if ('shapeSession' in d) {
      // Save the edits first, so the session starts from what is on screen.
      const go = () => window.SessionPanel && window.SessionPanel.start('shape', {});
      return picks.shape ? shapeCall('/api/setup/shape/draft', { shape: picks.shape, role: picks.role ?? shape.role }).then((r) => { paint(); if (r) go(); }) : go();
    }
    if ('sadd' in d) { picks.shape.sections.push({ name: '', note: '' }); return paint(); }
    if (d.sdel) { picks.shape.sections.splice(Number(d.sdel), 1); return paint(); }
    if ('shapeApply' in d) {
      const start = shape.needsShape && view.firstRunStarted;
      const names = picks.shape.sections.map((x) => x.name).join(', ');
      if (!confirm(`Use these sections: ${names}?${start ? ' The first ingest starts now.' : ''}`)) return;
      return shapeCall('/api/setup/shape/apply', { shape: picks.shape }).then(async (r) => {
        if (!r) return paint();
        view = await ctx.api('/api/setup');
        if (start) { const x = await ctx.api('/api/brain/bots/ingest/run', { method: 'POST', body: '{}' }); if (x.error) alert(x.error); }
        paint(); ctx.onChange(true);
      });
    }
    if ('graph' in d) { return ctx.api('/api/setup/obsidian', { method: 'POST', body: '{}' }).then((r) => { if (!r.written) alert(r.why); else alert(`Applied ${r.groups} color group(s); kept ${r.kept} of yours.`); view = r.view; paint(); }); }
    if ('first' in d) {
      const days = Number(picks['first-run'].days);
      if (!confirm(`Start the first run with a ${days}-day back-fill?`)) return;
      return ctx.api('/api/setup/first-run', { method: 'POST', body: JSON.stringify({ bootstrap_days: days }) }).then((r) => { if (r.error) alert(r.error); if (r.view) view = r.view; paint(); ctx.onChange(true); });
    }
  }

  function onInput(ev) {
    const t = ev.target;
    const d = t.dataset || {};
    if ('sq' in d) { picks.scope.q = t.value; const pos = t.selectionStart; paint(); const n = root.querySelector('[data-sq]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } return; }
    if ('stype' in d) { picks.scope.type = t.value; picks.scope.id = ''; return paint(); }
    if (d.pv) { picks.privacy[d.pv][t.value] = t.checked; return; }
    if (d.sch) { picks.schedule[d.sch] = t.type === 'checkbox' ? t.checked : t.value; return; }
    if ('share' in d) { picks.schedule.usage_share = t.value; return; }
    if ('bd' in d) { picks['first-run'].days = Number(t.value); return; }
    if ('role' in d) { picks.role = t.value; return; }
    if (d.sn !== undefined) { picks.shape.sections[Number(d.sn)].name = t.value.trim().toLowerCase(); return; }
    if (d.snote !== undefined) { picks.shape.sections[Number(d.snote)].note = t.value; return; }
    if ('stags' in d) { picks.shape.tags = t.value.split(',').map((x) => x.trim()).filter(Boolean); return; }
    if (d.f) { picks.identity = { ...(picks.identity || {}), [d.f]: t.value }; return; }
    if (d.conn) { picks.connectors = { ...(picks.connectors || {}), [d.conn]: t.value }; }
  }

  window.SetupPage = {
    mount(el, c) {
      ctx = c; root = el;
      el.onclick = onClick; el.oninput = onInput; el.onchange = onInput;
      el.innerHTML = '<div class="empty">Loading…</div>';
      load();
    },
    unmount(el) { if (el) { el.onclick = null; el.oninput = null; el.onchange = null; } root = null; },
  };
})();
