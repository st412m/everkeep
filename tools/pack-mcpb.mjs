#!/usr/bin/env node
// Builds the Claude Desktop extension (.mcpb) from an `npm pack` tarball, the same way
// as .github/workflows/mcpb.yml:
//   unpack the tarball → add manifest.json and icon.png → npm install --omit=dev
//   --omit=optional --ignore-scripts → refuse a bundle with anything in
//   node_modules/@napi-rs → start check (`node src/cli.js --version` in the bundle)
//   → mcpb validate → mcpb pack.
//
//   node tools/pack-mcpb.mjs <everkeep-x.y.z.tgz> [<out-dir>]
//
// Writes <out-dir>/everkeep-x.y.z.mcpb (default out-dir: out/ of the repository).
// Needs the network for npm and for the mcpb CLI, pinned to MCPB_CLI.
// --omit=optional keeps out the native canvas module of doclines' PDF reader: the
// bundle runs on any platform without it, and a native build for one platform would
// break the others.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';
const ROOT = path.resolve(import.meta.dirname, '..');

function run(cmd, cwd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', shell: true });
}

const q = (p) => `"${p}"`;

const tarball = process.argv[2] && path.resolve(process.argv[2]);
if (!tarball || !fs.existsSync(tarball)) {
  console.error('usage: node tools/pack-mcpb.mjs <everkeep-x.y.z.tgz> [<out-dir>]  (make the tarball with npm pack)');
  process.exit(2);
}
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (!path.basename(tarball).includes(`-${version}.tgz`)) {
  console.error(`the tarball ${path.basename(tarball)} is not version ${version} of package.json`);
  process.exit(1);
}
const outDir = path.resolve(process.argv[3] || path.join(ROOT, 'out'));
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `everkeep-${version}.mcpb`);
const work = fs.mkdtempSync(path.join(outDir, '.mcpb-build-'));
try {
  run(`tar -xzf ${q(tarball)} -C ${q(work)}`);
  const pkg = path.join(work, 'package');
  fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(pkg, 'manifest.json'));
  fs.copyFileSync(path.join(ROOT, 'icon.png'), path.join(pkg, 'icon.png'));
  run('npm install --omit=dev --omit=optional --ignore-scripts --no-package-lock --no-audit --no-fund', pkg);
  // npm may leave an empty @napi-rs scope folder behind: removed when empty, and the
  // build fails when anything is still in it.
  const napi = path.join(pkg, 'node_modules', '@napi-rs');
  if (fs.existsSync(napi) && fs.readdirSync(napi).length === 0) fs.rmdirSync(napi);
  if (fs.existsSync(napi)) {
    throw new Error(`node_modules/@napi-rs is in the bundle (${fs.readdirSync(napi).join(', ')}): a native module of one platform must not go into the extension`);
  }
  // The bundle starts and reports the version it was built from.
  const got = execFileSync(process.execPath, [path.join(pkg, 'src', 'cli.js'), '--version'], { encoding: 'utf8' }).trim();
  if (got !== version) throw new Error(`the bundle reports version ${got}, expected ${version}`);
  run(`npx -y ${MCPB_CLI} validate manifest.json`, pkg);
  run(`npx -y ${MCPB_CLI} pack ${q(pkg)} ${q(out)}`, pkg);
  console.log(`written: ${out} (${fs.statSync(out).size} bytes)`);
} catch (e) {
  console.error(`pack-mcpb: ${e.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
