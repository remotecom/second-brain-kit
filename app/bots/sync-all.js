// Sync All: every sync in one click, in the Morning run's order. Each sync is
// its own recorded run; this bot only starts them and adds up the result.
// No ingest, resolve or brief: those stay on the Morning run.

const { stepper, runSyncs } = require('../lib/schedule');

async function run(r, ctx) {
  const chain = stepper(r, ctx);
  await runSyncs(r, ctx.vault, ctx.logLine, chain);
  const { steps, cost } = chain;
  const failed = steps.filter((x) => / error$/.test(x));
  ctx.finish(r, failed.length ? 'warn' : 'ok', steps.join(' · ') || 'no source turned on', { steps }, cost);
}

module.exports = {
  id: 'sync-all', name: 'Sync All', kind: 'bash', group: 'g-syncs',
  blurb: 'Runs every sync that is turned on, one after the other. It costs the same as pressing each sync yourself. It does not ingest.',
  run,
};
