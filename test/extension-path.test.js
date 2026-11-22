'use strict';
// macOS under the Claude Desktop extension: Homebrew's folders go in front of
// the PATH the app was started with, so its sqlite3 and poppler are found
// before /usr/bin/sqlite3.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { homebrewPath, HOMEBREW_BIN } = require('../src/cli.js');
const { tmpDir, CLI, isolatedEnv } = require('./helpers.js');

const D = path.delimiter;
const has = list => d => list.includes(d);

test('existing Homebrew folders that are missing go in front, keg-only sqlite first', () => {
  assert.equal(homebrewPath(['/usr/bin', '/bin'].join(D), has(['/opt/homebrew/opt/sqlite/bin', '/opt/homebrew/bin'])),
    ['/opt/homebrew/opt/sqlite/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(D));
});

test('a folder already on PATH stays where it is; only the missing ones are added', () => {
  const current = ['/usr/bin', '/opt/homebrew/bin'].join(D);
  assert.equal(homebrewPath(current, has(HOMEBREW_BIN)),
    ['/opt/homebrew/opt/sqlite/bin', '/usr/local/opt/sqlite/bin', '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin'].join(D));
});

test('no Homebrew folder exists: PATH unchanged; an empty PATH gets the existing ones', () => {
  const current = ['/usr/bin', '/bin'].join(D);
  assert.equal(homebrewPath(current, () => false), current);
  assert.equal(homebrewPath('', has(['/usr/local/bin'])), '/usr/local/bin');
});

const brew = HOMEBREW_BIN.filter(d => fs.existsSync(d));
test('extension on macOS: the start says which Homebrew folders were added', {
  skip: process.platform !== 'darwin' ? 'runs on macOS' : !brew.length ? 'no Homebrew folder on this Mac' : false,
}, async () => {
  const home = tmpDir();
  const vault = path.join(home, 'notes');
  fs.mkdirSync(vault);
  const env = isolatedEnv(home, { EVERKEEP_EXTENSION: 'claude-desktop', PATH: ['/usr/bin', '/bin', path.dirname(process.execPath)].join(D) });
  const r = await new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, '--vault', vault], { env });
    let stderr = '';
    child.stderr.on('data', c => (stderr += c));
    child.stdin.end();
    child.on('exit', code => resolve({ code, stderr }));
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`PATH: Homebrew folders added in front: ${brew[0].replace(/[/]/g, '\\/')}`));
});
