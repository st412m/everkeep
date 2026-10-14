'use strict';
/**
 * Everkeep — configuration: config file, environment and flags. No network,
 * no writes.
 *
 * Config file lookup: env EVERKEEP_CONFIG (must exist), then
 * ~/.config/everkeep/config.json, then none (flags and env only).
 * Precedence: flags > env > file > defaults.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MB = 1024 * 1024;

const DEFAULTS = {
  port: 3100,
  host: '127.0.0.1',
  log_requests: false,
  max_doc_bytes: 50 * MB,
  max_text_bytes: 20 * MB,
  extract_timeout_s: 60,
  cache_max_mb: 512,
  policy_page: { mode: 'off' },
  allowed_hosts: [],
};

const PAGE_DEFAULTS = { port: 3101, users: [] };

const KEYS = new Set(['$comment', 'vault', 'port', 'host', 'log_requests', 'max_doc_bytes', 'max_text_bytes',
  'extract_timeout_s', 'cache_max_mb', 'policy_page', 'allowed_hosts', 'state_dir']);

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Path checks are written and tested for Linux only.
function platformRefusal(platform = process.platform) {
  if (platform === 'win32') return 'Windows is not supported natively (path checks are Linux-only); run Everkeep in Docker';
  if (platform === 'darwin') return 'macOS is not supported natively (path checks are Linux-only); run Everkeep in Docker';
  return null;
}

function envValue(env, name) {
  const v = env[name];
  return v === undefined || v === '' ? undefined : v;
}

function isPort(n) {
  return Number.isInteger(n) && n >= 0 && n <= 65535;
}

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

// An entry of allowed_hosts: a host name or address without scheme, port or
// path; an IPv6 address in brackets. null when it is valid.
function hostNameProblem(h) {
  if (typeof h !== 'string' || h === '') return 'every entry must be a non-empty string';
  if (h.includes('/')) return `"${h}" must be a host name, without a scheme or a path`;
  const v6 = /^\[[0-9A-Fa-f:.]+\]$/.test(h);
  if (!v6 && h.includes(':')) return `"${h}" must be a host name without a port (an IPv6 address goes in brackets)`;
  let parsed;
  try { parsed = new URL(`http://${h}`); } catch { return `"${h}" is not a valid host name`; }
  if (!parsed.hostname || parsed.port || parsed.username || parsed.pathname !== '/' || parsed.search || parsed.hash)
    return `"${h}" is not a valid host name`;
  return null;
}

// Validates the parsed file and returns its settings; defaults are not filled
// in here.
function parseConfig(raw, file) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${file}: must be a JSON object`);
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) problems.push(`unknown key "${k}"`);

  const c = raw.$comment;
  if (c !== undefined && typeof c !== 'string' && !(Array.isArray(c) && c.every(s => typeof s === 'string')))
    problems.push('"$comment" must be a string or an array of strings');
  for (const k of ['vault', 'state_dir']) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'string' || !path.isAbsolute(raw[k])) problems.push(`"${k}" must be an absolute path`);
  }
  if (raw.port !== undefined && !isPort(raw.port)) problems.push('"port" must be an integer 0-65535');
  if (raw.host !== undefined && (typeof raw.host !== 'string' || !raw.host)) problems.push('"host" must be a non-empty string');
  if (raw.log_requests !== undefined && typeof raw.log_requests !== 'boolean') problems.push('"log_requests" must be true or false');
  for (const k of ['max_doc_bytes', 'max_text_bytes', 'extract_timeout_s', 'cache_max_mb']) {
    if (raw[k] !== undefined && !isPositiveInt(raw[k])) problems.push(`"${k}" must be a positive integer`);
  }
  if (raw.allowed_hosts !== undefined) {
    if (!Array.isArray(raw.allowed_hosts)) problems.push('"allowed_hosts" must be an array of host names');
    else for (const h of raw.allowed_hosts) {
      const why = hostNameProblem(h);
      if (why) problems.push(`"allowed_hosts": ${why}`);
    }
  }
  if (raw.policy_page !== undefined) {
    const pp = raw.policy_page;
    if (!pp || typeof pp !== 'object' || Array.isArray(pp)) {
      problems.push('"policy_page" must be an object');
    } else if (pp.mode === 'off') {
      for (const k of Object.keys(pp)) if (k !== 'mode') problems.push(`unknown key "policy_page.${k}" (mode "off" takes no other keys)`);
    } else if (pp.mode === 'ha-ingress') {
      for (const k of Object.keys(pp)) if (!['mode', 'port', 'users'].includes(k)) problems.push(`unknown key "policy_page.${k}"`);
      if (pp.port !== undefined && !isPort(pp.port)) problems.push('"policy_page.port" must be an integer 0-65535');
      if (pp.users !== undefined && !(Array.isArray(pp.users) && pp.users.every(u => typeof u === 'string')))
        problems.push('"policy_page.users" must be an array of strings');
    } else {
      problems.push('"policy_page.mode" must be "off" or "ha-ingress"');
    }
  }
  if (problems.length) throw new ConfigError(`${file}: invalid config\n  ${problems.join('\n  ')}`);
  return raw;
}

function configCandidates({ env = process.env, cwd = process.cwd(), homedir = os.homedir() } = {}) {
  const list = [];
  const fromEnv = envValue(env, 'EVERKEEP_CONFIG');
  if (fromEnv) list.push({ path: path.resolve(cwd, fromEnv), source: 'env EVERKEEP_CONFIG', required: true });
  list.push({ path: path.join(homedir, '.config', 'everkeep', 'config.json'), source: '~/.config/everkeep/config.json' });
  return list;
}

function readConfigFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new ConfigError(`${file}: cannot read (${e.code || e.message})`); }
  try { return JSON.parse(text.replace(/^﻿/, '')); }
  catch (e) {
    // The engine message may quote a slice of the file; only the position is
    // reported.
    const m = /position (\d+)/.exec(e.message);
    let where = '';
    if (m) {
      const before = text.slice(0, Number(m[1]));
      where = ` at line ${before.split('\n').length}, column ${Number(m[1]) - before.lastIndexOf('\n')}`;
    }
    throw new ConfigError(`${file}: not valid JSON${where}`);
  }
}

/**
 * Resolved settings. `flags` holds the command-line values (vault, port,
 * host). Each setting comes with its source in `sources`. `vault` is null when
 * nothing names one: commands that need it check it themselves (requireVault).
 */
function loadConfig({ env = process.env, cwd = process.cwd(), homedir = os.homedir(), flags = {} } = {}) {
  const candidates = configCandidates({ env, cwd, homedir });
  let hit = null;
  for (const c of candidates) {
    if (fs.existsSync(c.path)) { hit = c; break; }
    if (c.required) throw new ConfigError(`config file from env EVERKEEP_CONFIG not found: ${c.path}`);
  }
  const file = hit ? parseConfig(readConfigFile(hit.path), hit.path) : {};
  const fileSrc = hit ? `config ${hit.path}` : null;

  const settings = {};
  const sources = {};
  const pick = (key, ...options) => {
    for (const [value, source] of options) {
      if (value !== undefined) { settings[key] = value; sources[key] = source; return; }
    }
  };

  pick('vault',
    [flags.vault !== undefined ? path.resolve(cwd, flags.vault) : undefined, 'flag --vault'],
    [envValue(env, 'EVERKEEP_VAULT') !== undefined ? path.resolve(cwd, env.EVERKEEP_VAULT) : undefined, 'env EVERKEEP_VAULT'],
    [file.vault !== undefined ? path.resolve(file.vault) : undefined, fileSrc],
    [null, 'none']);
  pick('port', [flags.port, 'flag --port'], [file.port, fileSrc], [DEFAULTS.port, 'default']);
  pick('host', [flags.host, 'flag --host'], [file.host, fileSrc], [DEFAULTS.host, 'default']);
  for (const k of ['log_requests', 'max_doc_bytes', 'max_text_bytes', 'extract_timeout_s', 'cache_max_mb'])
    pick(k, [file[k], fileSrc], [DEFAULTS[k], 'default']);
  pick('policy_page', [file.policy_page, fileSrc], [DEFAULTS.policy_page, 'default']);
  pick('allowed_hosts', [file.allowed_hosts, fileSrc], [DEFAULTS.allowed_hosts, 'default']);
  if (settings.policy_page.mode === 'ha-ingress')
    settings.policy_page = Object.assign({}, PAGE_DEFAULTS, settings.policy_page);
  pick('state_dir',
    [envValue(env, 'EVERKEEP_STATE_DIR') !== undefined ? path.resolve(cwd, env.EVERKEEP_STATE_DIR) : undefined, 'env EVERKEEP_STATE_DIR'],
    [file.state_dir !== undefined ? path.resolve(file.state_dir) : undefined, fileSrc],
    [path.join(homedir, '.local', 'state', 'everkeep'), 'default']);

  return {
    settings,
    sources,
    file: hit ? hit.path : null,
    fileSource: hit ? hit.source : null,
    searched: candidates.map(c => c.path),
  };
}

function requireVault(loaded) {
  if (!loaded.settings.vault)
    throw new ConfigError('no vault: pass --vault DIR, set env EVERKEEP_VAULT or "vault" in the config file');
  return loaded.settings.vault;
}

// The state directory holds the token and the document cache: inside the vault
// the tools could read them. Compared by real place where the paths exist.
function realOrLexical(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function assertStateOutsideVault(stateDir, vault) {
  // Inside = the same place, or a relative path that does not climb out (a
  // vault of "/" holds everything; startsWith(v + sep) would miss it).
  const rel = path.relative(realOrLexical(vault), realOrLexical(stateDir));
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)))
    throw new ConfigError(`state_dir ${stateDir} is inside the vault ${vault}: it holds the token and the document cache, which the tools must not reach`);
}

// The state directory is created on start with mode 0700; an existing one is
// left as it is.
function ensureStateDir(dir) {
  // Not writable (a Docker volume or bind mount owned by root while the
  // process runs as another user): say what to do, not a stack trace.
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const hint = owner => `state_dir ${dir} is not writable by this process` +
    (uid !== null ? ` (uid ${uid}${owner !== null ? `; the directory belongs to uid ${owner}` : ''})` : '') +
    `: make it writable for${uid !== null ? ` uid ${uid}` : ' this user'} (for a Docker volume or bind mount: chown ${uid !== null ? `${uid}:${uid}` : '<uid>:<gid>'} on it), run as its owner, or set state_dir to another directory`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') throw new ConfigError(hint(null));
    throw e;
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  } catch (e) {
    let owner = null;
    try { owner = fs.statSync(dir).uid; } catch {}
    throw new ConfigError(hint(owner));
  }
  return dir;
}

module.exports = {
  DEFAULTS, PAGE_DEFAULTS, ConfigError,
  platformRefusal, parseConfig, configCandidates, loadConfig, requireVault, ensureStateDir, assertStateOutsideVault,
};
