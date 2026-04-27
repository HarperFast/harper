'use strict';

import * as hdbLogger from '../utility/logging/harper_logger.js';
import util from 'util';
import childProcess from 'child_process';
const exec = util.promisify(childProcess.exec);
import * as sysInfo from '../utility/environment/systemInformation.js';

const STOP_MSG = 'Stopping Harper.';

export default async function stop(): Promise<void> {
	console.log(STOP_MSG);
	hdbLogger.notify(STOP_MSG);

	const processes = await sysInfo.getHDBProcessInfo();

	processes.core.forEach((p) => {
		exec(`kill ${p.pid}`);
	});
}
