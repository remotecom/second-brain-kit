// The Dock app: ~/Applications/Second Brain.app. It is a small bundle whose
// only job is to run app/bin/second-brain, which starts the server if needed
// and opens the app window. Without it, people had to find the launcher by
// its full path. `second-brain setup` makes it and adds it to the Dock once;
// `second-brain update` rewrites it, so it follows the kit if the kit moves.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NAME = 'Second Brain.app';
const BUNDLE_ID = 'dev.secondbrain.launcher';

const appPath = (home = os.homedir()) => path.join(home, 'Applications', NAME);

const plist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Second Brain</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>second-brain</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`;

// Finder starts apps with a bare PATH, so the script sets one the launcher
// can find node in.
const script = (kitDir) => `#!/bin/bash
# Second Brain Dock app: start the server if needed, then open the app window.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "${kitDir}/app/bin/second-brain" >/dev/null 2>&1
`;

// Writes (or rewrites) the bundle. Returns 'created', 'updated' or 'unchanged'.
function write(kitDir, home = os.homedir()) {
  const app = appPath(home);
  const files = [
    [path.join(app, 'Contents', 'Info.plist'), plist(), 0o644],
    [path.join(app, 'Contents', 'MacOS', 'second-brain'), script(kitDir), 0o755],
  ];
  const existed = fs.existsSync(app);
  let changed = false;
  for (const [f, text, mode] of files) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === text) continue;
    fs.writeFileSync(f, text, { mode });
    fs.chmodSync(f, mode);
    changed = true;
  }
  const icon = path.join(kitDir, 'app', 'assets', 'icon.icns');
  const iconDst = path.join(app, 'Contents', 'Resources', 'icon.icns');
  if (fs.existsSync(icon) && !(fs.existsSync(iconDst) && fs.readFileSync(iconDst).equals(fs.readFileSync(icon)))) {
    fs.mkdirSync(path.dirname(iconDst), { recursive: true });
    fs.copyFileSync(icon, iconDst);
    changed = true;
  }
  if (changed) { const now = new Date(); fs.utimesSync(app, now, now); } // Finder re-reads the icon
  return !existed ? 'created' : changed ? 'updated' : 'unchanged';
}

// Adds the app to the Dock, once. Returns 'added', 'already' or 'skipped: <why>'.
function addToDock(home = os.homedir()) {
  if (process.env.SECOND_BRAIN_NO_LAUNCHCTL) return 'skipped: test mode';
  const app = appPath(home);
  const url = `file://${encodeURI(app)}/`;
  const r = spawnSync('/usr/bin/defaults', ['read', 'com.apple.dock', 'persistent-apps'], { encoding: 'utf8' });
  if (r.status !== 0) return 'skipped: could not read the Dock settings';
  if (r.stdout.includes(encodeURI(NAME))) return 'already';
  const tile = `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${url}</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>`;
  const w = spawnSync('/usr/bin/defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', tile], { encoding: 'utf8' });
  if (w.status !== 0) return `skipped: ${String(w.stderr || '').trim()}`;
  spawnSync('/usr/bin/killall', ['Dock'], { stdio: 'ignore' }); // the Dock reloads its settings
  return 'added';
}

module.exports = { NAME, BUNDLE_ID, appPath, write, addToDock };
