'use strict';

const hdb_logger = require('../utility/logging/harper_logger');
const hdb_terms = require('../utility/hdbTerms');
const util = require('util');
const child_process = require('child_process');
const exec = util.promisify(child_process.exec);
const sys_info = require('../utility/environment/systemInformation');
const process_man = require('../utility/processManagement/processManagement');

const STOP_MSG = 'Stopping HarperDB.';

module.exports = stop;

async function stop() {
	console.log(STOP_MSG);
	hdb_logger.notify(STOP_MSG);
	if (await process_man.isServiceRegistered(hdb_terms.HDB_PROC_DESCRIPTOR)) process_man.enterPM2Mode();

	const services = await process_man.getUniqueServicesList();
	for (const service in services) {
		await process_man.stop(service);
	}

	// Kill process management daemon
	await process_man.kill();

	const processes = await sys_info.getHDBProcessInfo();
	processes.clustering.forEach((p) => {
		exec(`kill ${p.pid}`);
	});

	processes.core.forEach((p) => {
		exec(`kill ${p.pid}`);
	});
}
