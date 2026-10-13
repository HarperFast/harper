'use strict';

// Runs inside a Worker for nativeAddonGuard.test.js: loads real addons through Node's own .node
// loader, after installing the guard as if on a pointer-compression runtime unless execArgv did.

const { parentPort, workerData } = require('node:worker_threads');
const { installNativeAddonGuard } = require('#src/server/threads/nativeAddonGuard');

if (workerData.forceInstall) installNativeAddonGuard(process, true);

const report = {};
try {
	report.nodeApi = typeof require('argon2').hash;
} catch (error) {
	report.nodeApi = String(error);
}
try {
	require(workerData.incompatibleAddon);
	report.incompatible = 'loaded';
} catch (error) {
	report.incompatible = error.name;
}
parentPort.postMessage(report);
