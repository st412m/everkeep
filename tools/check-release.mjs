#!/usr/bin/env node
// Release consistency, also run by CI and by the image workflow. Checks
// - package.json version = the top entry of CHANGELOG.md = the everkeep@<v> pin
//   in the Dockerfile = server.json version = server.json packages[0].version =
//   the image tag in compose.example.yaml;
// - package.json mcpName = server.json name; packages[0] is the npm package
//   itself, on stdio, with a specific version;
// - server.json field limits of the 2025-12-11 schema: name pattern and 3–200
//   chars, description and title 1–100 chars;
// - server.json stays out of the npm package.
// No dependencies, no network.
//
//   node tools/check-release.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
export const SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const RANGE_RE = /[\^~><=*x ]|\|\|/;

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/** Returns a list of problems (empty when the release is consistent). */
export function checkRelease(root = ROOT) {
  const problems = [];
  const pkg = JSON.parse(read(root, 'package.json'));
  const server = JSON.parse(read(root, 'server.json'));
  const v = pkg.version;
  const versions = {
    'CHANGELOG.md top entry': /^## (\S+)/m.exec(read(root, 'CHANGELOG.md'))?.[1],
    'Dockerfile everkeep@': /\beverkeep@([^\s\\"]+)/.exec(read(root, 'Dockerfile'))?.[1],
    'server.json version': server.version,
    'server.json packages[0].version': server.packages?.[0]?.version,
    'compose.example.yaml image': /^\s*image:\s*ghcr\.io\/st412m\/everkeep:(\S+)\s*$/m.exec(read(root, 'compose.example.yaml'))?.[1],
  };
  for (const [where, got] of Object.entries(versions)) {
    if (got !== v) problems.push(`${where} is ${got ?? '(missing)'}, package.json version is ${v}`);
  }
  if (server.$schema !== SCHEMA_URL) problems.push(`server.json $schema is ${server.$schema}, expected ${SCHEMA_URL}`);
  if (pkg.mcpName !== server.name) problems.push(`package.json mcpName ${pkg.mcpName} != server.json name ${server.name}`);
  if (typeof server.name !== 'string' || !NAME_RE.test(server.name) || server.name.length < 3 || server.name.length > 200) problems.push(`server.json name is not a valid registry name: ${server.name}`);
  for (const field of ['description', 'title']) {
    const s = server[field];
    if (field === 'description' || s !== undefined) {
      if (typeof s !== 'string' || s.length < 1 || s.length > 100) problems.push(`server.json ${field} must be 1–100 chars (has ${s?.length ?? 0})`);
    }
  }
  const p0 = server.packages?.[0];
  if (!p0 || p0.registryType !== 'npm' || p0.identifier !== pkg.name) problems.push(`server.json packages[0] must be the npm package ${pkg.name}`);
  if (p0?.transport?.type !== 'stdio') problems.push('server.json packages[0].transport.type must be stdio');
  if (typeof p0?.version !== 'string' || RANGE_RE.test(p0.version)) problems.push(`server.json packages[0].version must be a specific version: ${p0?.version}`);
  if (!Array.isArray(pkg.files) || pkg.files.includes('server.json')) problems.push('server.json must stay out of the npm package (package.json files)');
  return problems;
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const problems = checkRelease();
  for (const p of problems) console.error(`check-release: ${p}`);
  if (problems.length) process.exitCode = 1;
  else console.log(`check-release: ${JSON.parse(read(ROOT, 'package.json')).version} everywhere, server.json ok`);
}
