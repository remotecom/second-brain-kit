// Settings for the bots, from <vault>/config.yaml (the kit's one config file;
// see config.example.yaml). Only flat blocks (owner:, schedule:) and simple
// lists are read, so a tiny parser is enough and the app stays dependency-free.
//
//   owner:
//     name: "Your Name"
//     slack_user_id: "U000XXXXX"
//     slack_self_dm_id: "D000XXXXX"
//     notion_user_id: ""          # blank = fall back to notion/.user-id
//
// Nothing about a specific person is hardcoded in the bots; a teammate's
// install differs only in this file.

const fs = require('fs');
const path = require('path');

// The scalar keys of one top-level section, e.g. readBlock(v, 'owner').
function readBlock(vault, section) {
  let text = '';
  try { text = fs.readFileSync(path.join(vault, 'config.yaml'), 'utf8'); } catch {}
  const out = {};
  let inside = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) { inside = (line.match(/^([a-z_]+):\s*(#.*)?$/) || [])[1] === section; continue; }
    if (!inside) continue;
    const m = line.match(/^\s{2}([a-z_]+):\s*(.*?)\s*(#.*)?$/);
    if (m && m[2] !== '') out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function readOwner(vault) {
  const owner = readBlock(vault, 'owner');
  if (!owner.notion_user_id) {
    try { owner.notion_user_id = fs.readFileSync(path.join(vault, 'notion', '.user-id'), 'utf8').trim(); } catch {}
  }
  return owner;
}

// Throws a readable error naming the missing keys, for the board to show.
function requireOwner(vault, keys) {
  const owner = readOwner(vault);
  const missing = keys.filter((k) => !owner[k] || /X{4,}/.test(owner[k]));
  if (missing.length) throw new Error(`set ${missing.map((k) => `owner.${k}`).join(', ')} in ${path.join(vault, 'config.yaml')}`);
  return owner;
}

// A list under a top-level section of config.yaml, e.g. readList(v, 'ingest',
// 'exclude') for
//   ingest:
//     exclude:
//       - notion/pages/x.md   # comment
function readList(vault, section, key) {
  let text = '';
  try { text = fs.readFileSync(path.join(vault, 'config.yaml'), 'utf8'); } catch {}
  const out = [];
  let inSection = false, inKey = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) { inSection = new RegExp(`^${section}:\\s*$`).test(line); inKey = false; continue; }
    if (!inSection) continue;
    if (new RegExp(`^\\s+${key}:\\s*$`).test(line)) { inKey = true; continue; }
    if (/^\s{2}[a-z_]+:/.test(line)) { inKey = false; continue; }
    const m = inKey && line.match(/^\s+-\s*["']?([^"'#\s]+)["']?/);
    if (m) out.push(m[1]);
  }
  return out;
}

const readIngestExcludes = (vault) => readList(vault, 'ingest', 'exclude');

module.exports = { readOwner, requireOwner, readBlock, readList, readIngestExcludes };
