'use strict';

const { parentPort, workerData } = require('node:worker_threads');

process.env.STORAGE_PATH = workerData.storagePath;
process.env.ROOTPATH = workerData.storagePath;

// The boot load never settles: only whether this thread has started one matters here.
const loadRootComponentsPath = require.resolve('#js/server/loadRootComponents');
require.cache[loadRootComponentsPath] = {
	id: loadRootComponentsPath,
	filename: loadRootComponentsPath,
	loaded: true,
	exports: { loadRootComponents: () => new Promise(() => {}) },
};

const { laterLoadsMeetFrozenIntrinsics } = require('#src/security/jsLoader');
const { startServers } = require('#js/server/threads/threadServer');

const beforeBootLoad = laterLoadsMeetFrozenIntrinsics();
startServers();
parentPort.postMessage({ type: 'probe', beforeBootLoad, afterBootLoad: laterLoadsMeetFrozenIntrinsics() });
