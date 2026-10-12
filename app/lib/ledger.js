// Pending-ID ledger (plan D13). An item that was listed but whose detail
// fetch failed (an issue's comments, a Notion page body) goes here instead of
// holding the whole source's watermark. The next run fetches these IDs on top
// of its normal window, so one stubborn item can't force a month-long re-fetch.
// The watermark still holds when a LIST call fails, since then we don't know
// what we missed.

const fs = require('fs');
const path = require('path');

const file = (vault, source) => path.join(vault, '.bot', 'state', `${source}-pending.json`);

function readPending(vault, source) {
  try { return JSON.parse(fs.readFileSync(file(vault, source), 'utf8')); } catch { return []; }
}

function writePending(vault, source, ids) {
  fs.mkdirSync(path.dirname(file(vault, source)), { recursive: true });
  const uniq = [...new Map(ids.map((x) => [JSON.stringify(x), x])).values()];
  fs.writeFileSync(file(vault, source), JSON.stringify(uniq, null, 2));
}

module.exports = { readPending, writePending };
