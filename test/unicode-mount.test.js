'use strict';
// Unicode and letter case on EVERKEEP_TEST_CI_MOUNT (see unicode-cases.js).
const MOUNT = process.env.EVERKEEP_TEST_CI_MOUNT;
require('./unicode-cases.js')(MOUNT, MOUNT ? false : 'EVERKEEP_TEST_CI_MOUNT is not set');
