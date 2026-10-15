// node --test: the Dock app bundle (lib/dock-app.js). A temp HOME; the Dock
// itself is never touched (SECOND_BRAIN_NO_LAUNCHCTL).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.SECOND_BRAIN_NO_LAUNCHCTL = '1';
const D = require('../lib/dock-app');
const KIT = path.resolve(__dirname, '..', '..');

test('write makes a runnable bundle that calls this kit, and rewrites only on change', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dock-'));
  assert.strictEqual(D.write(KIT, home), 'created');
  const app = D.appPath(home);
  const exe = path.join(app, 'Contents', 'MacOS', 'second-brain');
  assert.ok(fs.statSync(exe).mode & 0o100, 'the script is executable');
  assert.match(fs.readFileSync(exe, 'utf8'), new RegExp(`exec "${KIT}/app/bin/second-brain"`));
  const info = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
  assert.match(info, /<key>CFBundleExecutable<\/key><string>second-brain<\/string>/);
  assert.ok(fs.existsSync(path.join(app, 'Contents', 'Resources', 'icon.icns')), 'the icon is copied');
  assert.strictEqual(D.write(KIT, home), 'unchanged');
  // The kit moved: the script follows it.
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-kit-'));
  assert.strictEqual(D.write(moved, home), 'updated');
  assert.match(fs.readFileSync(exe, 'utf8'), new RegExp(`exec "${moved}/app/bin/second-brain"`));
});

test('addToDock never touches the real Dock in test mode', () => {
  assert.strictEqual(D.addToDock(os.tmpdir()), 'skipped: test mode');
});
