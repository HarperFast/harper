'use strict';

const hdbLogger = require('../utility/logging/harper_logger.js');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const systemInformation = require('../utility/environment/systemInformation.ts');

const STOP_MSG = 'Stopping Harper.';

module.exports = stop;

async function stop() {
	console.log(STOP_MSG);
	hdbLogger.notify(STOP_MSG);

	const processes = await systemInformation.getHDBProcessInfo();
	for (const { pid } of processes.core) {
		exec(`kill ${pid}`);
	}
}
