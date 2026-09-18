'use strict';

const { parentPort } = require('node:worker_threads');

require('#src/utility/environment/environmentManager').initTestEnvironment();
require('#js/server/threads/manageThreads');

parentPort.postMessage({ type: 'fixture-ready' });
setInterval(() => {}, 10_000);
