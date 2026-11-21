'use strict';
// Windows file system cases on EVERKEEP_TEST_CI_MOUNT (see windows-fs-cases.js).
const MOUNT = process.env.EVERKEEP_TEST_CI_MOUNT;
require('./windows-fs-cases.js')(MOUNT, MOUNT ? false : 'EVERKEEP_TEST_CI_MOUNT is not set');
