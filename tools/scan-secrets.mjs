#!/usr/bin/env node
// Scans a repository for values that must not be published: private
// addresses, MACs, tokens, personal paths, e-mail addresses and keys.
//
//   node tools/scan-secrets.mjs [repo-root ...]
//
// Default root: this repository. Another root (the Home Assistant app
// repository) can be given as well. Files: every file under the root except
// .git/, node_modules/, test/fixtures/ and what the root's .gitignore names
// (plain names, "dir/", "*.ext" and "prefix*" lines; that is all the
// repositories use). Text files only: .js, .mjs, .cjs, .sh, .yaml, .yml,
// .json, .md, Dockerfile*, .gitignore, .gitattributes, .dockerignore, LICENSE.
// Findings are printed as file:line:column and the rule, never the matched
// value. A line carrying the marker scan-secrets:allow is skipped.
// package-lock.json gets the address checks only (its integrity hashes are
// long base64). Exit code 1 on any finding.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const ALLOW = 'scan-secrets:allow';
const ALWAYS_SKIP = new Set(['.git', 'node_modules']);
const SKIP_PATHS = [/^test\/fixtures\//];
const TEXT = /(?:\.(?:[cm]?js|sh|ya?ml|json|md)|(?:^|\/)Dockerfile[^/]*|(?:^|\/)\.(?:gitignore|gitattributes|dockerignore)|(?:^|\/)LICENSE)$/;
const ADDRESS_ONLY = new Set(['package-lock.json']);

// Documentation ranges (RFC 5737), loopback, the Supervisor address.
function allowedIp(ip) {
  return ip === '172.30.32.2' || ip === '127.0.0.1' ||
    /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(ip);
}

function privateIp(ip) {
  const o = ip.split('.').map(Number);
  if (o.some(n => n > 255)) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

// Example domains (RFC 2606) are not addresses of anyone.
function exampleMail(m) {
  return /@(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i.test(m);
}

const RULES = [
  { kind: 'private IPv4', address: true, re: /(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.]?\d)/g,
    keep: m => privateIp(m) && !allowedIp(m) },
  { kind: 'MAC address', address: true, re: /(?<![0-9A-Fa-f:-])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:-])/g },
  { kind: 'token path prefix', re: /private_[A-Za-z0-9_-]{8,}/g,
    // the 2.x default, a known placeholder
    keep: m => m !== 'private_changeme' },
  { kind: 'Windows user path', re: /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"`]+/gi,
    // the placeholder user of the examples
    keep: m => !/[\\/](?:me|username)$/i.test(m) },
  { kind: 'home directory', re: /\/home\/[a-z_][a-z0-9_.-]*/g,
    keep: m => !/^\/home\/(?:me|node)$/.test(m) },
  { kind: 'long hex string', re: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])/g },
  { kind: 'long base64 string', re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}/g,
    // a test value marked FAKE is not a secret
    keep: m => /[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) && !/FAKE/.test(m) },
  { kind: 'token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g },
  { kind: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'e-mail address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    keep: m => !exampleMail(m),
    // the maintainer address of the Home Assistant app repository, by position
    skipLine: (file, line) => file === 'repository.yaml' && /^maintainer:/.test(line) },
];

// .gitignore lines this scanner understands, as a test on a relative path.
function ignoreTest(root) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n'); } catch {}
  const tests = [];
  for (let l of lines) {
    l = l.trim();
    if (!l || l.startsWith('#') || l.startsWith('!')) continue;
    const dirOnly = l.endsWith('/');
    const pat = l.replace(/\/$/, '').replace(/^\//, '');
    const rx = new RegExp('^' + pat.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    tests.push((rel, isDir) => (!dirOnly || isDir) && (rx.test(rel) || rx.test(path.posix.basename(rel))));
  }
  return (rel, isDir) => tests.some(t => t(rel, isDir));
}

export function listFiles(root) {
  const ignored = ignoreTest(root);
  const out = [];
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (ALWAYS_SKIP.has(e.name) || ignored(r, e.isDirectory()) || SKIP_PATHS.some(s => s.test(r + (e.isDirectory() ? '/' : '')))) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && TEXT.test(r)) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

// [{ line, column, kind }] for one file's text.
export function scanText(text, rel) {
  const found = [];
  const addressOnly = ADDRESS_ONLY.has(rel);
  text.split('\n').forEach((line, i) => {
    if (line.includes(ALLOW)) return;
    for (const rule of RULES) {
      if (addressOnly && !rule.address) continue;
      if (rule.skipLine && rule.skipLine(rel, line)) continue;
      for (const m of line.matchAll(rule.re)) {
        if (rule.keep && !rule.keep(m[0])) continue;
        found.push({ line: i + 1, column: m.index + 1, kind: rule.kind, length: m[0].length });
      }
    }
  });
  return found;
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const roots = process.argv.length > 2 ? process.argv.slice(2).map(r => path.resolve(r)) : [ROOT];
  let findings = 0, scanned = 0;
  for (const root of roots) {
    for (const rel of listFiles(root)) {
      const buf = fs.readFileSync(path.join(root, rel));
      if (buf.subarray(0, 8192).includes(0)) continue;
      scanned++;
      for (const f of scanText(buf.toString('utf8'), rel)) {
        findings++;
        console.log(`${path.basename(root)}/${rel}:${f.line}:${f.column}: ${f.kind} (${f.length} chars)`);
      }
    }
  }
  console.log(`files scanned: ${scanned}`);
  console.log(`findings: ${findings}`);
  process.exitCode = findings ? 1 : 0;
}
