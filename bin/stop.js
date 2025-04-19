'use strict';

const hdbLogger = require('../utility/logging/harper_logger.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const sysInfo = require('../utility/environment/systemInformation.js');
const processMan = require('../utility/processManagement/processManagement.js');

const STOP_MSG = 'Stopping HarperDB.';

module.exports = stop;

async function stop() {
	console.log(STOP_MSG);
	hdbLogger.notify(STOP_MSG);
	const isPm2Mode = await processMan.isServiceRegistered(hdbTerms.PROCESS_DESCRIPTORS.HDB);
	if (isPm2Mode) {
		processMan.enterPM2Mode();
		const services = await processMan.getUniqueServicesList();
		for (const service in services) {
			await processMan.stop(service);
		}
	}

	// Kill process management daemon
	await processMan.kill();

	const processes = await sysInfo.getHDBProcessInfo();
	processes.clustering.forEach((p) => {
		exec(`kill ${p.pid}`);
	});

	processes.core.forEach((p) => {
		exec(`kill ${p.pid}`);
	});
}
