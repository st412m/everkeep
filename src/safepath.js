'use strict';
/**
 * Everkeep — the one place a path is checked against the vault
 *
 * The check hands back a branded value instead of a string, and policy.js,
 * retention.js and sqlite.js refuse anything else.
 *
 * The brand is a frozen { path } registered in this module's private `issued`
 * map. Nothing outside this file can put an entry in it, so an object of the
 * same shape built by hand is not a path as far as pathOf() is concerned. Not
 * a class (`instanceof` can be forged with Object.create) and not a flag on the
 * object.
 *
 * The map's value is the private record of the resolver that issued the
 * brand, not the object createResolver hands back. So child(), parent() and
 * canonical() are module-level functions that know which vault a path belongs
 * to, while the brand constructor stays inside this file: the returned
 * resolver is frozen and exposes root, resolveSafe, child, parent and
 * canonical, none of which mints a brand for an unchecked string.
 * issued.has(x) is the whole verification.
 *
 * The boundary: createResolver is exported, so code in this process that
 * builds a resolver over another root gets brands under that root. This
 * guards against a forgotten check, not against code that deliberately goes
 * around it.
 *
 * UNVERIFIED_PATH means a module was called with a path that did not come from
 * here. It is an internal contract failure, not a user-visible refusal: every
 * tool resolves its argument before touching anything, so a client on /mcp
 * cannot produce it. Refusals about the vault boundary are a different error.
 */

const fs = require('fs');
const path = require('path');

// brand -> the resolver that issued it. Weak, so a brand holds nothing alive,
// and private, so only the code in this file can register one.
const issued = new WeakMap();

// String containment. Not a bare startsWith(root), which would accept a sibling
// sharing the prefix (/media/VAULT_backup for /media/VAULT). No disk access, so
// it takes strings: callers pass `.path`.
function inside(p, root) {
  return p === root || p.startsWith(root + path.sep);
}

// Case folding for comparisons that ignore case.
function foldCase(s) {
  return s.normalize('NFC').toUpperCase().toLowerCase();
}

// Reserved names (.vault-policy, trash names) are compared without regard to
// case on every file system: on a vault that ignores case, .VAULT-POLICY is
// the marker. Takes names, not paths.
function sameName(a, b) {
  return a === b || foldCase(a) === foldCase(b);
}

// Whether two path strings name the same place. Equal strings: yes. Different
// even when case is ignored: no. Different only in case: yes when both exist
// and are one file system object (dev and ino from lstat), which happens on a
// file system that ignores case; a missing path is not the same. Read-only.
function samePath(a, b) {
  if (a === b) return true;
  if (foldCase(a) !== foldCase(b)) return false;
  let x, y;
  try {
    x = fs.lstatSync(a, { bigint: true });
    y = fs.lstatSync(b, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
  return x.dev === y.dev && x.ino === y.ino;
}

function swapCase(s) {
  return [...s].map(c => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
}

// Whether the vault root ignores case, for messages only: the checks above do
// not depend on it. Looks at the root's entries whose names contain a letter:
// 'insensitive' when one of them, with its case swapped, is the same object;
// 'sensitive' when none is; 'unknown' when there is nothing to probe (or the
// root cannot be read). Read-only.
function probeCase(rootPath) {
  let names;
  try { names = fs.readdirSync(rootPath); } catch { return 'unknown'; }
  let probed = false;
  for (const n of names) {
    const swapped = swapCase(n);
    if (swapped === n) continue;
    probed = true;
    if (samePath(path.join(rootPath, n), path.join(rootPath, swapped))) return 'insensitive';
  }
  return probed ? 'sensitive' : 'unknown';
}

// The line check-config and the start line print for probeCase().
function caseNote(probe) {
  if (probe === 'insensitive') return 'case-insensitive vault';
  if (probe === 'sensitive') return 'case-sensitive vault';
  return 'case sensitivity: unknown (no entry to probe)';
}

function isSafePath(x) {
  return issued.has(x);
}

// The gate every module puts in front of its path arguments. `where` names the
// calling function in the error message.
function pathOf(x, where) {
  if (!issued.has(x))
    throw new Error(`UNVERIFIED_PATH: ${where} requires a path produced by resolveSafe(), got ${typeof x}`);
  return x.path;
}

function describeName(name) {
  return typeof name === 'string' ? JSON.stringify(name.slice(0, 40)) : typeof name;
}

// One step down from a verified path, for tree walks: the name comes from a
// readdir of that directory, so no realpath is needed.
//
// The guarantee is lexical: child() does not resolve symlinks, and the walks
// using it do not follow them (they test the dirent type, or lstat). Where a
// write lands is decided by resolveSafe(), never by child(): a name from a
// policy marker can point at a symlink out of the vault.
function child(parent, name) {
  const base = pathOf(parent, 'child');
  // path.sep matters only on Windows; it keeps path.join() from seeing a
  // separator.
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes(path.sep) ||
      name.includes('\0') || name === '.' || name === '..')
    throw new Error(`UNVERIFIED_PATH: child() takes one path segment, got ${describeName(name)}`);
  return issued.get(parent).make(path.join(base, name));
}

// One step up, with a full check, not the lexical dirname: resolveSafe()
// verifies realpath at the path itself, not at its ancestors, so the parent of
// a verified path (for example under a symlink that leaves the vault and leads
// back in) is checked again. This costs a realpath on every write.
function parent(p) {
  const dir = path.dirname(pathOf(p, 'parent'));
  return issued.get(p).resolveSafe(dir);
}

// The real place of a verified path, expressed under ROOT: symlinks on the way
// are resolved, a tail that does not exist yet is kept as is. Policies and
// trash comparisons use this; what a tool prints keeps the lexical path.
function canonical(p) {
  const lexical = pathOf(p, 'canonical');
  return issued.get(p).canonical(lexical);
}

// One resolver per process and per root: server.js and the grep worker over
// ALLOWED_DIR, policy-page.js over the same vault.
function createResolver(rootPath) {
  const ROOT = path.resolve(rootPath);

  // Real path of the vault, resolved once. On HAOS the vault root is reached
  // through a symlink (/media → /mnt/data/supervisor/media), so escape checks
  // compare against the resolved root.
  let REAL_ROOT = ROOT;
  try { REAL_ROOT = fs.realpathSync(ROOT); } catch {}

  function make(p) {
    const b = Object.freeze({ path: p });
    issued.set(b, internal);
    return b;
  }

  // Refuses a path outside ROOT (a sibling sharing the name prefix included)
  // and a path whose realpath leaves REAL_ROOT. For a path that does not exist
  // yet (write_file, create_directory, move_file destinations) the nearest
  // existing ancestor is resolved instead.
  function resolveSafe(p) {
    if (typeof p !== 'string' || !p) throw new Error('path must be a non-empty string');
    const resolved = path.resolve(p);
    if (!inside(resolved, ROOT)) throw new Error(`PATH_OUTSIDE_VAULT: ${p}`);
    let probe = resolved;
    for (;;) {
      try {
        const real = fs.realpathSync(probe);
        if (!inside(real, REAL_ROOT)) throw new Error(`PATH_OUTSIDE_VAULT: ${p} (symlink resolves outside the vault)`);
        return make(resolved);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const up = path.dirname(probe);
        if (up === probe || !inside(up, ROOT)) throw new Error(`PATH_OUTSIDE_VAULT: ${p}`);
        probe = up;
      }
    }
  }

  // realpath of the nearest existing ancestor, mapped from REAL_ROOT back to
  // ROOT, plus the missing tail. Any realpath error other than ENOENT throws.
  function canonicalOf(lexical) {
    const tail = [];
    let probe = lexical;
    for (;;) {
      let real;
      try {
        real = fs.realpathSync(probe);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const up = path.dirname(probe);
        if (up === probe) throw new Error(`PATH_OUTSIDE_VAULT: ${lexical}`);
        tail.unshift(path.basename(probe));
        probe = up;
        continue;
      }
      if (!inside(real, REAL_ROOT)) throw new Error(`PATH_OUTSIDE_VAULT: ${lexical} (symlink resolves outside the vault)`);
      const out = path.join(ROOT, path.relative(REAL_ROOT, real), ...tail);
      if (!inside(out, ROOT)) throw new Error(`PATH_OUTSIDE_VAULT: ${lexical}`);
      return make(out);
    }
  }

  // What the WeakMap stores. child(), parent() and canonical() reach the
  // constructor and the check through it — never through the object returned
  // below, which carries no way to mint a brand.
  const internal = { make, resolveSafe, canonical: canonicalOf };

  // The root is branded directly rather than resolved, so a vault that does not
  // exist yet still gives a usable resolver.
  return Object.freeze({ root: make(ROOT), resolveSafe, child, parent, canonical });
}

module.exports = {
  createResolver, isSafePath, pathOf, inside, child, parent, canonical,
  sameName, samePath, probeCase, caseNote,
};
