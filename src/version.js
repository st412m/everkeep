'use strict';
// The version has one source: package.json.

const VERSION = require('../package.json').version;

// doclines' own version, without loading the library itself.
const DOCLINES_VERSION = require('doclines/package.json').version;

module.exports = { VERSION, DOCLINES_VERSION };
