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
const path = require('path');
const crypto = require('crypto');

const install = require('./lib/install');
const PORT = install.port();
const STATE_DIR = install.STATE_DIR;
const VAULT = install.resolveVault();
// Without a vault the bots have nothing to work on; the page says how to set up.
const brain = VAULT ? require('./lib/brain') : null;
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
const NOT_SET_UP = `<!doctype html><meta charset="utf-8"><title>Second Brain</title>
<body style="font:15px -apple-system,system-ui;background:#1e1e1e;color:#e4e4e4;padding:40px;max-width:640px">
<h1>Second Brain is not set up yet</h1><p>Open Terminal and run:</p>
<pre style="background:#111;padding:12px;border-radius:6px">${path.join(__dirname, 'bin', 'second-brain')} setup</pre>
<p>Setup creates your vault, writes its settings and starts the app at login.</p></body>`;
const ALLOWED = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

const CLAUDE = install.findClaude();

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
// A request for a vendored file under public/vendor is served like any other.

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const origin = req.headers.origin;
  if (origin && !ALLOWED.has(origin)) { res.writeHead(403); return res.end('cross-origin request refused'); }
  if (url.pathname.startsWith('/api/') && (req.headers['x-brain-token'] || '') !== TOKEN) { res.writeHead(401); return res.end('missing or bad token'); }
  try {
    if (!brain && url.pathname.startsWith('/api/')) return json(res, 503, { error: 'not set up', fix: 'Run `second-brain setup` in Terminal.' });
    if (brain && await brain.handle(req, res, url, { json, readBody, claudeBin: CLAUDE })) return;
    if (!brain) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(NOT_SET_UP); }
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

// Sessions stream over a websocket. Browsers cannot set headers on one, so
// the token rides in the URL; the Origin check still applies (OV-f).
const { WebSocketServer } = require('./lib/vendor/ws');
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const s = brain && brain.sessions() && brain.sessions().get(url.searchParams.get('session') || '');
  if (!ALLOWED.has(req.headers.origin || '') || url.searchParams.get('token') !== TOKEN || !s) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => {
    s.clients.add(ws);
    ws.send(JSON.stringify({ type: 'replay', data: s.replay, state: s.state, session: s.toJSON() }));
    ws.on('message', (m) => {
      let msg; try { msg = JSON.parse(String(m)); } catch { return; }
      if (msg.type === 'in' && typeof msg.data === 'string') s.write(msg.data);
      else if (msg.type === 'resize') s.resize(Math.max(20, Math.min(400, msg.cols | 0)), Math.max(5, Math.min(200, msg.rows | 0)));
    });
    ws.on('close', () => s.clients.delete(ws));
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} is in use; Second Brain is probably already running.`); process.exit(0); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Second Brain on http://localhost:${PORT}  (vault=${VAULT || 'NOT SET UP'}, claude=${CLAUDE || 'MISSING'})`);
  if (brain) brain.start(CLAUDE);
});
