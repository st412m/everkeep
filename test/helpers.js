'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after } = require('node:test');

// A fresh temp dir per call, removed when the test file finishes. Resolved with
// the native realpath: on Windows the JS realpath keeps 8.3 short names.
function tmpDir(prefix = 'everkeep-') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

// What the start line and check-config add after the vault for its letter
// case: nothing on a case-sensitive file system (Linux; NTFS and APFS ignore
// case by default).
function caseSuffix(vault) {
  const SP = require('../src/safepath.js');
  const probe = SP.probeCase(vault);
  return probe === 'sensitive' ? '' : `, ${SP.caseNote(probe)}`;
}

// A skip reason when this process cannot create symlinks (on Windows that
// needs Developer Mode or admin rights), false otherwise.
function symlinkSkip() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'everkeep-link-'));
  try {
    fs.symlinkSync(dir, path.join(dir, 'link'), 'dir');
    return false;
  } catch {
    return 'creating symlinks is not permitted here (on Windows: Developer Mode or admin rights)';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// NTFS has no POSIX file modes.
const POSIX_MODES = process.platform !== 'win32';

// An environment that cannot pick up the real config, state dir or token.
// os.homedir() reads HOME on Linux and macOS, USERPROFILE on Windows.
function isolatedEnv(home, extra = {}) {
  return { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...extra };
}

module.exports = { tmpDir, writeJson, CLI, isolatedEnv, caseSuffix, symlinkSkip, POSIX_MODES };
