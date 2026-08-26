'use strict';

const assert = require('node:assert');
const { parentPort, workerData } = require('node:worker_threads');

process.env.STORAGE_PATH = workerData.storagePath;
process.env.HDB_ROOT = workerData.storagePath;

const loadRootComponentsPath = require.resolve('#src/server/loadRootComponents');
require.cache[loadRootComponentsPath] = {
	id: loadRootComponentsPath,
	filename: loadRootComponentsPath,
	loaded: true,
	exports: {
		loadRootComponents() {
			return new Promise((resolve) => {
				const completionTimer = setTimeout(resolve, 50);
				completionTimer.unref();
				assert.equal(completionTimer.hasRef(), false, 'fixture completion source must not hold the event loop');
			});
		},
	},
};

const { startServers } = require('#src/server/threads/threadServer');

parentPort.unref();
startServers();
