'use strict';

const assert = require('node:assert');
const { parentPort, workerData } = require('node:worker_threads');

process.env.STORAGE_PATH = workerData.storagePath;
process.env.ROOTPATH = workerData.storagePath;

let stubRan = false;
const loadRootComponentsPath = require.resolve('#js/server/loadRootComponents');
require.cache[loadRootComponentsPath] = {
	id: loadRootComponentsPath,
	filename: loadRootComponentsPath,
	loaded: true,
	exports: {
		loadRootComponents() {
			stubRan = true;
			let resolveLoading;
			const loading = new Promise((resolve) => {
				resolveLoading = resolve;
			});
			const completionTimer = setTimeout(resolveLoading, 50);
			completionTimer.unref();
			assert.equal(completionTimer.hasRef(), false, 'fixture completion source must not hold the event loop');
			return loading;
		},
	},
};

const { startServers } = require('#js/server/threads/threadServer');

parentPort.unref();
startServers();
assert.equal(stubRan, true, 'fixture loadRootComponents stub was not used');
