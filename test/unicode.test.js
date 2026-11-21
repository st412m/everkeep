'use strict';
// Unicode and letter case in the temp folder's file system (see unicode-cases.js).
require('./unicode-cases.js')(require('os').tmpdir(), false);
