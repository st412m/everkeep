'use strict';
/**
 * Everkeep — the HTTP token: where it comes from, how it is generated and kept.
 *
 * Order: --token-file, env EVERKEEP_TOKEN, <state_dir>/token, else a new one is
 * generated and saved there. Never from the config file or the command line.
 * A generated token is 32 random bytes as 64 hex characters, saved with mode
 * 0600 through a temporary file and a rename.
 *
 * The token itself is printed only by `everkeep token` and once at generation
 * (cli.js); no message of this module carries it.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateToken, TokenError } = require('./http');

const TOKEN_FILE = 'token';
const HINT = 'run `everkeep token --new` for a generated one';

function tokenPath(stateDir) {
  return path.join(stateDir, TOKEN_FILE);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// null when the file does not exist.
function readStored(stateDir) {
  try { return fs.readFileSync(tokenPath(stateDir), 'utf8').trim(); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function writeStored(stateDir, token) {
  const file = tokenPath(stateDir);
  const tmp = path.join(stateDir, `.token.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  return file;
}

function envValue(env, name) {
  const v = env[name];
  return v === undefined || v === '' ? undefined : v;
}

// A token kept from before 1.0 that breaks the rules: honoured only inside
// Home Assistant (SUPERVISOR_TOKEN set) with EVERKEEP_ALLOW_LEGACY_TOKEN=1.
function legacyAllowed(env) {
  return env.EVERKEEP_ALLOW_LEGACY_TOKEN === '1' && Boolean(envValue(env, 'SUPERVISOR_TOKEN'));
}

/**
 * The token in force. Returns { token, source, generated, legacy, file } or
 * throws TokenError. With generate: false a missing token is an error instead.
 */
function resolveToken({ tokenFile, env = process.env, stateDir, generate = true }) {
  let given, source;
  if (tokenFile !== undefined) {
    try { given = fs.readFileSync(tokenFile, 'utf8').trim(); }
    catch (e) { throw new TokenError(`cannot read --token-file (${e.code || e.message})`); }
    source = '--token-file';
  } else if (envValue(env, 'EVERKEEP_TOKEN') !== undefined) {
    given = env.EVERKEEP_TOKEN.trim();
    source = 'env EVERKEEP_TOKEN';
  }

  if (source) {
    try {
      validateToken(given);
      return { token: given, source, generated: false, legacy: false, file: null };
    } catch (e) {
      if (given && legacyAllowed(env))
        return { token: given, source, generated: false, legacy: true, file: null };
      throw new TokenError(`token from ${source}: ${e.message}; ${HINT}`);
    }
  }

  const file = tokenPath(stateDir);
  const stored = readStored(stateDir);
  if (stored !== null) {
    try { validateToken(stored); }
    catch (e) { throw new TokenError(`token in ${file}: ${e.message}; ${HINT}`); }
    return { token: stored, source: file, generated: false, legacy: false, file };
  }

  if (!generate) throw new TokenError(`no token yet: \`everkeep serve\` generates one on its first start, or ${HINT}`);
  const token = generateToken();
  writeStored(stateDir, token);
  return { token, source: file, generated: true, legacy: false, file };
}

// `everkeep token --new`: replaces the stored token.
function replaceToken(stateDir) {
  const token = generateToken();
  const file = writeStored(stateDir, token);
  return { token, file };
}

// The two lines `everkeep token` prints and generation shows once.
function connectionLines(token) {
  return [`/private_${token}/mcp`, `Authorization: Bearer ${token}`];
}

module.exports = {
  TOKEN_FILE, tokenPath, generateToken, readStored, legacyAllowed,
  resolveToken, replaceToken, connectionLines,
};
