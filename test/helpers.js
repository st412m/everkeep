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

// The CLI refuses to start natively on Windows and macOS.
const NATIVE = process.platform !== 'win32' && process.platform !== 'darwin';
const SKIP_CLI = NATIVE ? false : 'the CLI refuses to start natively on Windows and macOS; these tests run on Linux';

// An environment that cannot pick up the real config, state dir or token.
function isolatedEnv(home, extra = {}) {
  return { PATH: process.env.PATH, HOME: home, ...extra };
}

module.exports = { tmpDir, writeJson, CLI, NATIVE, SKIP_CLI, isolatedEnv };
