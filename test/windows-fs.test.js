'use strict';
// Windows file system cases in the temp folder (see windows-fs-cases.js).
require('./windows-fs-cases.js')(require('os').tmpdir(), false);
