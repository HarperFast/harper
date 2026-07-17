'use strict';

const { parentPort } = require('node:worker_threads');

parentPort.postMessage({
	importLoaded: globalThis.__harperImportPreloaded === true,
	requireLoaded: globalThis.__harperRequirePreloaded === true,
	execArgv: process.execArgv,
});
