'use strict';

const hdbLogger = require('../utility/logging/harper_logger.js');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const sysInfo = require('../utility/environment/systemInformation.js');

const STOP_MSG = 'Stopping HarperDB.';

module.exports = stop;

async function stop() {
	console.log(STOP_MSG);
	hdbLogger.notify(STOP_MSG);

	const processes = await sysInfo.getHDBProcessInfo();
	processes.clustering.forEach((p) => {
		exec(`kill ${p.pid}`);
	});

	processes.core.forEach((p) => {
		exec(`kill ${p.pid}`);
	});
}
