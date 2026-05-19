'use strict';

import * as fs from 'fs-extra';
import * as path from 'path';
import * as YAML from 'yaml';

import * as hdbTerms from '../utility/hdbTerms.ts';
import hdbLog from '../utility/logging/harper_logger.ts';
import * as systemInformation from '../utility/environment/systemInformation.ts';
import * as envMgr from '../utility/environment/environmentManager.ts';
import * as installation from '../utility/installation.ts';
envMgr.initSync();

const STATUSES = {
	RUNNING: 'running',
	STOPPED: 'stopped',
	ERRORED: 'errored',
	NOT_INSTALLED: 'not installed',
};

let hdbRoot;

export default status;

async function status() {
	let status: any = {
		harperdb: {
			status: STATUSES.STOPPED,
		},
	};

	if (!installation.isHdbInstalled(envMgr, hdbLog)) {
		status.harperdb.status = STATUSES.NOT_INSTALLED;
		console.log(YAML.stringify(status));
		return;
	}

	hdbRoot = envMgr.get(hdbTerms.CONFIG_PARAMS.ROOTPATH);
	let hdbPid;
	try {
		hdbPid = Number.parseInt(await fs.readFile(path.join(hdbRoot, hdbTerms.HDB_PID_FILE), 'utf8'));
	} catch (err) {
		if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) {
			hdbLog.info('`harperdb status` did not find a hdb.pid file');
			status.harperdb.status = STATUSES.STOPPED;
			console.log(YAML.stringify(status));
			return;
		}

		throw err;
	}

	// Check the saved pid against any running hdb processes
	const hdbSysInfo = await systemInformation.getHDBProcessInfo();
	for (const proc of hdbSysInfo.core) {
		if (proc.pid === hdbPid) {
			status.harperdb.status = STATUSES.RUNNING;
			status.harperdb.pid = hdbPid;
			break;
		}
	}

	console.log(YAML.stringify(status));
	process.exit();
}
