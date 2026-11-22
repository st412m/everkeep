'use strict';
// tools/check-release.mjs on the Claude Desktop extension manifest: the
// repository passes; a manifest out of step with package.json or the server's
// tools, or a wrong icon, is reported.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { TOOLS } = require('../src/server.js');
const { tmpDir } = require('./helpers.js');

const ROOT = path.join(__dirname, '..');
const names = TOOLS.map(t => t.name);
const load = () => import(pathToFileURL(path.join(ROOT, 'tools', 'check-release.mjs')).href);

// A copy of the files check-release reads, with manifest.json changed by edit.
function copyWith(edit) {
  const dir = tmpDir();
  for (const f of ['package.json', 'server.json', 'CHANGELOG.md', 'Dockerfile', 'compose.example.yaml', 'manifest.json', 'icon.png'])
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  edit(m, dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  return dir;
}

test('the repository: no problems, the manifest lists the 20 tools in order', async () => {
  const { checkRelease } = await load();
  assert.deepEqual(checkRelease(ROOT, { toolNames: names }), []);
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.tools.map(t => t.name), names);
  assert.equal(names.length, 20);
});

test('version, tools, entry point, env and icon out of step: each reported', async () => {
  const { checkRelease } = await load();
  const cases = [
    [m => { m.version = '0.0.1'; }, /manifest\.json version is 0\.0\.1/],
    [m => { m.tools.pop(); }, /manifest\.json tools .* differ from src\/server\.js/],
    [m => { m.tools[0].description = ''; }, /every tool needs a description/],
    [m => { m.server.mcp_config.args[0] = 'src/cli.js'; }, /args\[0\] must be \$\{__dirname\}\/src\/cli\.js/],
    [m => { delete m.server.mcp_config.env.EVERKEEP_EXTENSION; }, /EVERKEEP_EXTENSION must be claude-desktop/],
    [m => { m.compatibility.runtimes.node = '>=20'; }, /runtimes\.node is >=20/],
    [(m, dir) => { fs.writeFileSync(path.join(dir, 'icon.png'), 'not a png'); }, /icon\.png is not a PNG/],
  ];
  for (const [edit, re] of cases) {
    const problems = checkRelease(copyWith(edit), { toolNames: names });
    assert.ok(problems.some(p => re.test(p)), `${re}: ${problems.join(' | ')}`);
  }
});
