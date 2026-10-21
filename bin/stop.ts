'use strict';

import hdbLogger from '../utility/logging/harper_logger.ts';
import * as util from 'util';
import * as childProcess from 'child_process';
const exec = util.promisify(childProcess.exec);
import * as systemInformation from '../utility/environment/systemInformation.ts';
import { PRODUCT_NAME } from '../utility/packageUtils.js';

const STOP_MSG = `Stopping ${PRODUCT_NAME}.`;

export default stop;

async function stop() {
	console.log(STOP_MSG);
	hdbLogger.notify(STOP_MSG);

	const processes = await systemInformation.getHDBProcessInfo();
	for (const { pid } of processes.core) {
		exec(`kill ${pid}`);
	}
}
