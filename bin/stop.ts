'use strict';

import hdbLogger from '../utility/logging/harper_logger.ts';
import { setTimeout as delay } from 'node:timers/promises';
import * as systemInformation from '../utility/environment/systemInformation.ts';
import { isProcessRunning } from '../utility/processManagement/processManagement.ts';
import { getProcessShutdownTimeoutMs } from '../components/shutdownDrain.ts';
import { PRODUCT_NAME } from '../utility/packageUtils.js';

const STOP_MSG = `Stopping ${PRODUCT_NAME}.`;
// Beyond threads.shutdownTimeout: harper dev's 30 s default (this separate process cannot see DEV_MODE)
// and the storage close at exit, which nothing bounds yet (rocksdb-js#1001)
const EXIT_ALLOWANCE_MS = 60000;
const EXIT_POLL_INTERVAL_MS = 100;

export default stop;

async function stop() {
	console.log(STOP_MSG);
	hdbLogger.notify(STOP_MSG);

	const processes = await systemInformation.getHDBProcessInfo();
	const signalled = [];
	for (const { pid } of processes.core) {
		try {
			process.kill(pid, 'SIGTERM');
			signalled.push(pid);
		} catch (error) {
			if (error.code !== 'ESRCH') throw error;
		}
	}
	const giveUpAt = Date.now() + getProcessShutdownTimeoutMs() + EXIT_ALLOWANCE_MS;
	while (signalled.some(isProcessRunning)) {
		if (Date.now() >= giveUpAt)
			throw new Error(`${PRODUCT_NAME} (pid ${signalled.filter(isProcessRunning).join(', ')}) is still shutting down`);
		await delay(EXIT_POLL_INTERVAL_MS);
	}
}
