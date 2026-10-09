#!/usr/bin/env node
// Second Brain app: chat with your vault and run the bots that keep it.
// A small local server plus one page. Everything lives in lib/:
//   brain.js      chat + bot registry + HTTP routes
//   sync.js       model-driven sync (Calendar, Drive) and the shared gate
//   slack-mcp.js  Slack: model presses buttons, code writes the files
//   linear-mcp.js Linear: same pattern
//   notion-mcp.js Notion: same pattern
//   ingest.js     fold raw files into wiki pages
//
// Access control (same reasoning as Briefcase, which this grew out of):
// loopback binding alone is not enough, because a page you visit can fire a
// "simple" POST at localhost. Every /api call needs a matching Origin AND a
// token that only the page served from here has.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.SECOND_BRAIN_PORT || 19300);
const STATE_DIR = process.env.SECOND_BRAIN_STATE_DIR || path.join(os.homedir(), '.second-brain');
process.env.BRIEFCASE_STATE_DIR = STATE_DIR; // lib/brain.js reads this name
const brain = require('./lib/brain');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(STATE_DIR, { recursive: true });
const TOKEN_FILE = path.join(STATE_DIR, 'token');
let TOKEN;
try {
  TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (TOKEN.length < 32) throw new Error('short');
} catch {
  TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
}
const ALLOWED = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

function findClaude() {
  for (const p of [path.join(os.homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (fs.existsSync(p)) return p;
  }
  try { return execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}
const CLAUDE = findClaude();

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const origin = req.headers.origin;
  if (origin && !ALLOWED.has(origin)) { res.writeHead(403); return res.end('cross-origin request refused'); }
  if (url.pathname.startsWith('/api/') && (req.headers['x-brain-token'] || '') !== TOKEN) { res.writeHead(401); return res.end('missing or bad token'); }
  try {
    if (await brain.handle(req, res, url, { json, readBody, claudeBin: CLAUDE })) return;
    const rel = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^[/\\]+/, '');
    const full = path.join(PUBLIC_DIR, rel);
    if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
    let body = fs.readFileSync(full);
    if (rel === 'index.html') body = String(body).replace('__BRAIN_TOKEN__', TOKEN);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} is in use; Second Brain is probably already running.`); process.exit(0); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Second Brain on http://localhost:${PORT}  (vault=${brain.VAULT}, claude=${CLAUDE || 'MISSING'})`);
  brain.start(CLAUDE);
});
