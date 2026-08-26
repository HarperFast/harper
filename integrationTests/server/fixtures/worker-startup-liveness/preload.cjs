'use strict';

const Module = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');

// Worker execArgv loads this before threadServer. Replacing only the worker-side root loader
// isolates the ready handshake from incidental component/storage handles; the main process still
// boots normally and creates the actual four-worker HTTP pool exercised by the test.
const loadRootComponentsPath = require.resolve(process.env.HARPER_TEST_LOAD_ROOT_COMPONENTS_PATH);
const replacement = new Module(loadRootComponentsPath);
replacement.filename = loadRootComponentsPath;
replacement.loaded = true;
replacement.exports = {
	loadRootComponents() {
		const startupMode = process.env.HARPER_TEST_WORKER_STARTUP_MODE;
		return delay(100, undefined, { ref: startupMode === 'ref' }).then(() => {
			if (startupMode === 'reject') throw new Error('deliberate worker component startup rejection');
		});
	},
};
require.cache[loadRootComponentsPath] = replacement;
