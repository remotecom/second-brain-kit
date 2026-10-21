// Make me better's Apply, as the owner sees it: which step it is on, what it
// waits for, and how it ended. The gate (apply.js) is not changed; this file
// reads what the gate already writes:
//
//   the 'apply' run record   (brain.js: its log lines, then finish() with the
//                             gate's result in run.detail)
//   apply.json               (the runner: switching ──▶ applied | rolled-back | failed)
//
//   view(run, last) picks the newer of the two:
//
//     run running ─────────────────────────────▶ running (step from the newest known log line)
//     apply.json written after the run started ─▶ switching | applied | rolled-back | failed
//     run ended with the gate's 'confirm' ──────▶ waiting  (guard files to confirm)
//     run ended with an error ──────────────────▶ error    (failed tests, if any)
//     run stopped by a restart (reconcile) ─────▶ stopped  (nothing was switched)
//
// The step names match apply.js log lines. If the gate words a line another
// way, the strip shows "Working" and the line itself; a test pins each one.

const KG = require('./kit-git');
const F = require('./features');

const STEPS = [
  { id: 'check', label: 'Checking the change', re: /^Apply: checking the change/ },
  { id: 'replay', label: 'Replaying your change on newer code', re: /^your copy changed since this work started/ },
  { id: 'tests', label: 'Running the tests (about 2 minutes)', re: /^running the tests in the dev copy/ },
  { id: 'trusted', label: 'Running the tests your app trusts on the new code', re: /^running the live kit's own tests/ },
  { id: 'smoke', label: 'Trial start of the new code on a spare port', re: /^smoke start: the new code on a spare port/ },
];
const WORKING = { id: 'working', label: 'Working' };

// A run log line is "HH:MM:SS text"; sub-steps are indented.
const textOf = (line) => String(line || '').replace(/^\d\d:\d\d:\d\d /, '').trim();
function stepOf(line) {
  const t = textOf(line);
  return STEPS.find((s) => s.re.test(t)) || null;
}
// The newest log line that names a step.
function currentStep(log = []) {
  for (let i = log.length - 1; i >= 0; i--) { const s = stepOf(log[i]); if (s) return s; }
  return WORKING;
}

const short = (sha) => String(sha || '').slice(0, 7);
const after = (a, b) => !!a && (!b || Date.parse(a) >= Date.parse(b));

// What the strip shows. run: the newest 'apply' run record (or null).
// last: apply.json (or null). opts.fresh: apply.json says switching and is
// still young (apply-state.switching). opts.devHead: the dev copy's commit now.
function view(run, last, { fresh = false, devHead = null } = {}) {
  const l = last && last.state ? last : null;
  if (run && run.status === 'running') {
    const step = currentStep(run.log);
    return { state: 'running', mode: 'apply', runId: run.id, startedAt: run.startedAt, step: { id: step.id, label: step.label }, line: textOf((run.log || []).slice(-1)[0]), hold: true };
  }
  // apply.json is newer than the run (or there is no run: an Undo).
  if (l && (!run || after(l.at, run.startedAt))) {
    const base = { mode: l.mode || 'apply', from: l.from, to: l.to, at: l.at, reason: l.reason || null };
    if (l.state === 'switching') {
      return fresh
        ? { ...base, state: 'switching', step: { id: 'switching', label: l.mode === 'undo' ? 'Going back; the app restarts' : 'Switching to the new code; the app restarts' }, hold: true }
        : { ...base, state: 'failed', reason: 'the switch did not report back. Run `second-brain doctor`.' };
    }
    return { ...base, state: l.state };
  }
  if (!run || run.dismissed) return { state: 'idle' };
  const d = run.detail || {};
  const base = { mode: 'apply', runId: run.id, startedAt: run.startedAt, endedAt: run.endedAt, summary: run.summary };
  if (d.kind === 'stopped') return { ...base, state: 'stopped' };
  if (d.status === 'confirm') {
    return { ...base, state: 'waiting', sha: d.sha, guards: d.guards || [], trustedFailures: d.trustedFailures || [], canConfirm: !devHead || devHead === d.sha };
  }
  if (run.status === 'error') return { ...base, state: 'error', failures: d.failures || [] };
  return { state: 'idle' };
}

// The feature notes a switch brought in (or, for Undo, took out): notes at
// the newer commit that the older one does not have. With none, the commit
// subjects.
function titles(kit, last) {
  if (!last || !last.from || !last.to) return [];
  const [older, newer] = last.mode === 'undo' ? [last.to, last.from] : [last.from, last.to];
  const had = new Set(F.atRef(kit, older).map((n) => n.id));
  const got = F.atRef(kit, newer).filter((n) => !n.invalid && n.id && !had.has(n.id)).map((n) => n.title || n.id);
  if (got.length) return got;
  const r = KG.git(kit, 'log', '--format=%s', '-5', `${older}..${newer}`);
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

// The banner after a restart, from apply.json. null when there is nothing to say.
function banner(last, names = []) {
  if (!last || !last.state || last.state === 'switching') return null;
  const what = names.length ? names.join('; ') : 'your change';
  const undo = last.mode === 'undo';
  if (last.state === 'applied') {
    return { kind: 'ok', at: last.at, text: undo ? `Undo worked. It took out: ${what}. The app now runs ${short(last.to)}.` : `Applied: ${what}. The app now runs ${short(last.to)}.` };
  }
  if (last.state === 'rolled-back') {
    return { kind: 'bad', at: last.at, text: `The last ${undo ? 'Undo' : 'Apply'} did not work, so the app went back to ${short(last.from)}. Why: ${last.reason || 'not known'}. Your change is still in the dev copy. Open Make me better to fix it.` };
  }
  return { kind: 'bad', at: last.at, text: `The last ${undo ? 'Undo' : 'Apply'} stopped with an error: ${last.reason || 'not known'}. Run \`second-brain doctor\`.` };
}

// At server start: an 'apply' run record still marked running means the app
// stopped during it. If apply.json changed after the run started, the gate
// had handed over to the runner; apply.json tells the rest. If not, nothing
// was switched.
function reconcile(run, last) {
  if (!run || run.status !== 'running') return null;
  if (last && last.state && after(last.at, run.startedAt)) {
    return { status: 'ok', summary: 'handed over to the switch; see the result of the switch', detail: { status: 'switching', handedOver: true } };
  }
  return { status: 'error', summary: 'the app restarted while Apply checked the change, so nothing was switched. A test run may still finish in the background; it changes nothing. Press Apply again.', detail: { kind: 'stopped' } };
}

// The Apply job, run in the background. The run record is saved at the start
// and at each line, so a restart in the middle leaves a trace (reconcile).
// ctx: { apply(opts) (apply.js apply with its context), logLine, finish, save }.
async function runApply(run, ctx, confirm = null) {
  const log = (m) => { ctx.logLine(run, m); ctx.save(run); };
  log('Apply: checking the change before it reaches the app');
  try {
    const r = await ctx.apply({ confirm, log });
    ctx.finish(run, r.status === 'error' ? 'error' : r.status === 'confirm' ? 'warn' : 'ok', r.summary, r);
    return r;
  } catch (e) {
    ctx.finish(run, 'error', (e && e.message) || String(e), { status: 'error' });
    return { status: 'error', summary: (e && e.message) || String(e) };
  }
}

module.exports = { STEPS, stepOf, currentStep, view, titles, banner, reconcile, runApply };
