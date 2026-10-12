// Where the kit lives, and the kit scripts the bots run. The scripts belong to
// the kit, not to the vault: every vault runs the same copy, and the vault
// path goes in as --vault.

const path = require('path');

const KIT_DIR = path.resolve(__dirname, '..', '..');
const script = (name) => path.join(KIT_DIR, 'scripts', name);

module.exports = { KIT_DIR, script };
