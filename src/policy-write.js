'use strict';
/**
 * Everkeep — writing and removing .vault-policy markers
 *
 * The only code that writes markers. Required by policy-page.js (the Vault
 * policies page) and cli.js (`everkeep policy`) only; the MCP dispatcher
 * (server.js) has no reference to it.
 *
 * Every path goes through the resolver of the caller: the directory is
 * checked with resolveSafe(), and so are both destinations of a write (the
 * marker and its temporary file), since the directory may have become a
 * symlink out of the vault after it was checked.
 */

const fs = require('fs');
const path = require('path');
const P = require('./policy');
const SP = require('./safepath');

// The `_` field: free text, kept parseable as before.
function preamble(mode) {
  return 'Everkeep policy. Applies to this directory and everything below it, ' +
    'until a deeper marker of the same name is met. ' +
    `Managed with ${P.policyEditor(mode)} — edit by hand only to repair it.`;
}

/**
 * A directory that may hold a marker: inside the vault (resolveSafe), no
 * segment named like the marker, an existing directory and not a symlink, and
 * not the trash or inside it. Returns the checked path or throws.
 */
function targetDir(R, given) {
  // The name check comes first and is lexical: through an existing marker file
  // resolveSafe() would stop at ENOTDIR with a less telling message.
  if (typeof given === 'string' && given) {
    const lexical = path.resolve(given);
    if (path.relative(R.root.path, lexical).split(path.sep).some(s => SP.sameName(s, P.POLICY_FILE)))
      throw new Error(`${lexical}: a path through ${P.POLICY_FILE} cannot hold a marker`);
  }
  const dir = R.resolveSafe(given);
  const rel = path.relative(R.root.path, dir.path);
  let st;
  try { st = fs.lstatSync(dir.path); } catch { throw new Error(`${dir.path} does not exist`); }
  if (!st.isDirectory()) throw new Error(`${dir.path} is not a directory`);
  if (rel) {
    // As trash_file decides it: the trash in force in the parent, compared at
    // the directory's real place.
    const zone = P.policyAt(R.parent(dir), R.root);
    const real = path.join(zone.real.path, path.basename(dir.path));
    if (P.inTrash(real, P.trashDirOf(zone.policy)))
      throw new Error(`${dir.path} is in the trash; a marker cannot go there`);
  }
  return dir;
}

// The marker of dir under the name it has on disk. On a vault that ignores
// case an existing .VAULT-POLICY is the marker and is written over in place,
// not joined by a second file.
function markerPath(dir) {
  const lexical = SP.child(dir, P.POLICY_FILE);
  let names = [];
  try { names = fs.readdirSync(dir.path); } catch {}
  for (const n of names) {
    if (n === P.POLICY_FILE || !SP.sameName(n, P.POLICY_FILE)) continue;
    const cand = SP.child(dir, n);
    if (SP.samePath(cand.path, lexical.path)) return cand;
  }
  return lexical;
}

/**
 * What specOf() needs to know about the directory: `own` — the fields of its
 * own marker as parseMarker() returns them (null when it has none or it cannot
 * be read); `parentHasTrash` — the policy in force in the parent has a trash;
 * `currentOn` — a trash is in force at the directory now.
 */
function contextOf(R, dir) {
  let own = null;
  try {
    const m = markerPath(dir);
    if (fs.lstatSync(m.path).isFile()) own = P.parseMarker(fs.readFileSync(m.path, 'utf8'));
  } catch {}
  const isRoot = path.relative(R.root.path, dir.path) === '';
  const parent = isRoot ? P.unrestricted() : P.policyAt(R.parent(dir), R.root).policy;
  const here = P.policyAt(dir, R.root).policy;
  return { own, parentHasTrash: !!P.trashDirOf(parent), currentOn: !!here.trash };
}

/**
 * A change as the page sends it — { mode, trash, trashName, trashNameGiven,
 * retention_enabled, retention_days } — turned into the fields the directory
 * sets itself; a field left out is inherited (applyMarker). `everkeep policy
 * set` builds the same shape, so both write the same bytes.
 *
 * - readonly/overwrite: always.
 * - trash: the current marker's value when it has the key and the trash was not
 *   changed (switched on or off, or a name given); otherwise left out when the
 *   trash is on, the parent has one and no name was given (the parent's trash
 *   is shared); null when it is off and the parent has one; a name — an own
 *   trash here — when the parent has none or a name was given. A read-only zone
 *   has no trash: null when the parent has one, else left out.
 * - retention_enabled/retention_days: only together with an own trash.
 */
function specOf(change, ctx = { own: null, parentHasTrash: false, currentOn: false }) {
  const readonly = change.mode === 'readonly';
  const spec = { readonly, overwrite: readonly ? 'never' : change.mode };
  if (!['rev', 'never', 'free'].includes(spec.overwrite))
    throw new Error(`unknown mode "${change.mode}"`);

  // Checked even when the days end up not written: a bad value is refused,
  // not dropped.
  const days = parseInt(change.retention_days, 10);
  if (Number.isInteger(days) && (days < 1 || days > 3650))
    throw new Error('"retention_days" must be a whole number of days between 1 and 3650');

  const on = !readonly && !!change.trash;
  const changed = on !== !!ctx.currentOn || !!change.trashNameGiven;
  let trash;   // undefined: the key is left out
  if (readonly) trash = ctx.parentHasTrash ? null : undefined;
  else if (ctx.own && 'trash' in ctx.own && !changed) trash = ctx.own.trash;
  else if (on) trash = (change.trashNameGiven || !ctx.parentHasTrash) ? P.validTrashName(change.trashName || P.DEFAULT_TRASH) : undefined;
  else trash = ctx.parentHasTrash ? null : undefined;

  if (trash !== undefined) spec.trash = trash;
  if (typeof trash === 'string') {
    spec.retention_enabled = !!change.retention_enabled;
    spec.retention_days = parseInt(change.retention_days, 10);
    if (!Number.isInteger(spec.retention_days)) spec.retention_days = 30;
  }
  return spec;
}

// The marker text for spec, validated before anything is written: a marker
// that cannot be parsed would lock the zone. Keys absent from spec are not
// written.
function markerText(spec, mode) {
  const body = { _: preamble(mode) };
  for (const k of ['readonly', 'overwrite', 'trash', 'retention_enabled', 'retention_days'])
    if (k in spec) body[k] = spec[k];
  P.parseMarker(JSON.stringify(body));
  return JSON.stringify(body, null, 2) + '\n';
}

// Writes the marker of dir (a path from targetDir). Returns the marker path.
function writeMarker(R, dir, spec, mode) {
  const text = markerText(spec, mode);
  const target = R.resolveSafe(markerPath(dir).path);
  const tmp = R.resolveSafe(SP.child(dir, `.vault-policy.tmp-${process.pid}-${Date.now()}`).path);
  fs.writeFileSync(tmp.path, text, 'utf8');
  try { fs.renameSync(tmp.path, target.path); }
  catch (e) { try { fs.unlinkSync(tmp.path); } catch {} throw e; }
  return target.path;
}

// unlink does not follow the final symlink, so the lexical path is enough.
function removeMarker(dir) {
  const target = SP.child(dir, P.POLICY_FILE);
  try { fs.unlinkSync(target.path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return target.path;
}

module.exports = { preamble, targetDir, markerPath, contextOf, specOf, markerText, writeMarker, removeMarker };
