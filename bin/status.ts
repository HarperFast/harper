'use strict';

import * as fs from 'fs-extra';
import * as path from 'path';
import * as YAML from 'yaml';

import * as hdbTerms from '../utility/hdbTerms.ts';
import hdbLog from '../utility/logging/harper_logger.ts';
import * as systemInformation from '../utility/environment/systemInformation.ts';
import * as envMgr from '../utility/environment/environmentManager.ts';
import * as installation from '../utility/installation.ts';
import { prettyDuration } from '../utility/common_utils.ts';
envMgr.initSync();

const STATUSES = {
	RUNNING: 'running',
	STOPPED: 'stopped',
	ERRORED: 'errored',
	NOT_INSTALLED: 'not installed',
};

let hdbRoot;

export default status;

/** Uptime in ms between two epoch-ms timestamps. Both are absolute (UTC) instants, so the result is
 * timezone- and DST-independent; negative spans clamp to 0. */
export function processUptimeMs(startMs: number, nowMs: number): number {
	return Math.max(0, Math.round(nowMs - startMs));
}

/** Format uptime, then print the status object as YAML. */
function report(status: any): void {
	if (typeof status.harperdb.uptime === 'number') {
		status.harperdb.uptime = prettyDuration(status.harperdb.uptime);
	}
	console.log(YAML.stringify(status));
	// Set exitCode rather than calling process.exit(0), which can truncate buffered stdout when the
	// output is piped; the event loop drains and exits 0 on its own.
	process.exitCode = 0;
}

async function status() {
	let status: any = {
		harperdb: {
			status: STATUSES.STOPPED,
		},
	};

	if (!installation.isHdbInstalled(envMgr, hdbLog)) {
		status.harperdb.status = STATUSES.NOT_INSTALLED;
		return report(status);
	}

	hdbRoot = envMgr.get(hdbTerms.CONFIG_PARAMS.ROOTPATH);
	const pidFile = path.join(hdbRoot, hdbTerms.HDB_PID_FILE);
	let hdbPid;
	try {
		hdbPid = Number.parseInt(await fs.readFile(pidFile, 'utf8'));
	} catch (err) {
		if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) {
			// A missing pid file is the normal stopped state (clean shutdown removes it), not an error.
			status.harperdb.status = STATUSES.STOPPED;
			return report(status);
		}

		throw err;
	}

	// Check the saved pid against any running hdb processes
	const hdbSysInfo = await systemInformation.getHDBProcessInfo();
	for (const proc of hdbSysInfo.core) {
		if (proc.pid === hdbPid) {
			status.harperdb.status = STATUSES.RUNNING;
			status.harperdb.pid = hdbPid;
			// `status` is a separate short-lived CLI process, so `process.uptime()` would report its own
			// age, not the server's. The pid file is written once at startup, so its mtime is an epoch
			// timestamp for when the server started — a numeric UTC instant, so subtracting it from now
			// is DST-safe (no local-time string to round-trip, unlike systeminformation's `proc.started`).
			try {
				const { mtimeMs } = await fs.stat(pidFile);
				status.harperdb.uptime = processUptimeMs(mtimeMs, Date.now());
			} catch (err) {
				hdbLog.warn(`\`harperdb status\` could not determine uptime: ${err}`);
			}
			break;
		}
	}

	return report(status);
}
