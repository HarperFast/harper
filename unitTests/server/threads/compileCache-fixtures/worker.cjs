'use strict';

const { getCompileCacheDir } = require('node:module');
const { parentPort } = require('node:worker_threads');

parentPort.postMessage({
	cacheDirectory: getCompileCacheDir?.(),
	envDirectory: process.env.NODE_COMPILE_CACHE,
	jobMark: process.env.COMPILE_CACHE_TEST_JOB,
});
