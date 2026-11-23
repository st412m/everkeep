'use strict';
// src/cli.js started by a host script, as Claude Desktop's built-in Node does:
// require.main is the host and argv[1] is cli.js. The server must start, and a
// refusal must end the process even while the host keeps a handle open.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tmpDir, CLI, isolatedEnv } = require('./helpers.js');

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

// The host drops itself from argv, so argv[1] is the entry point as under
// Claude Desktop, loads it with require() and keeps a timer running, as the
// host's message channel keeps the process alive.
function hostScript(dir) {
  const host = path.join(dir, 'host.js');
  fs.writeFileSync(host, "'use strict';\nprocess.argv.splice(1, 1);\nsetInterval(() => {}, 1000);\nrequire(process.argv[1]);\n");
  return host;
}

function runHosted(home, args, extraEnv, { closeStdin = true } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [hostScript(home), CLI, ...args], { env: isolatedEnv(home, extraEnv) });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => (stdout += c));
    child.stderr.on('data', c => (stderr += c));
    // A refusal can end the child before it reads stdin: the write then fails
    // with EPIPE (seen on macOS runners), which is expected here.
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(INIT) + '\n');
    if (closeStdin) child.stdin.end();
    const timer = setTimeout(() => child.kill(), 10000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

test('under a host: the stdio server starts and answers initialize', async () => {
  const home = tmpDir();
  const vault = path.join(home, 'notes');
  fs.mkdirSync(vault);
  const r = await runHosted(home, ['--vault', vault], {});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim()).result.serverInfo.name, 'everkeep');
});

test('under a host: a refusal ends the process with code 1, the message on stderr', async () => {
  const home = tmpDir();
  const r = await runHosted(home, [], { EVERKEEP_EXTENSION: 'yes' }, { closeStdin: false });
  assert.equal(r.signal, null, 'not killed by the 10 s guard');
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /EVERKEEP_EXTENSION must be "claude-desktop"/);
});

test('required by another module (not started): main() does not run', () => {
  const home = tmpDir();
  const r = require('child_process').spawnSync(process.execPath, ['-e', `require(${JSON.stringify(CLI)})`], { env: isolatedEnv(home), input: JSON.stringify(INIT) + '\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});
