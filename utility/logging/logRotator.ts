'use strict';

import { promises as fsProm, createReadStream, createWriteStream, mkdirSync } from 'fs';
import { createGzip } from 'zlib';
import { promisify } from 'util';
import { pipeline } from 'stream';
const pipe = promisify(pipeline);
import * as path from 'path';
import * as envMgr from '../environment/environmentManager.ts';
envMgr.initSync();
import hdbLogger from './harper_logger.ts';
import { CONFIG_PARAMS } from '../hdbTerms.ts';
import { convertToMS } from '../common_utils.ts';
import { onStorageReclamation } from '../../server/storageReclamation.ts';

// Interval in ms to check log file and decide if it should be rotated.
const LOG_AUDIT_INTERVAL = 60000;
const INT_SIZE_UNDEFINED_MSG =
	"'interval' and 'maxSize' are both undefined, to enable logging rotation at least one of these values must be defined in harperdb-config.yaml";

let lastRotationTime;
let setIntervalId;

export default logRotator;

/**
 * Rotates hdb.log using an interval and/or maxSize param to determine if log should be rotated.
 * Uses an unref setInterval to periodically check time passed since rotation and size of log file.
 * If log file is within the values set in config, log file will be renamed/moved and a new empty hdb.log created.
 * @returns LogRotator
 */
function logRotator({ logger, maxSize, interval, retention, enabled, path: rotatedLogDir, auditInterval }: any) {
	if (enabled === false) return;
	let reclamationPriority = 0;
	onStorageReclamation(
		logger.path,
		(priority) => {
			reclamationPriority = priority;
		},
		true
	);

	if (!maxSize && !interval) {
		throw new Error(INT_SIZE_UNDEFINED_MSG);
	}

	if (!rotatedLogDir) {
		rotatedLogDir = path.join(path.dirname(logger.path), 'rotated');
	}
	mkdirSync(rotatedLogDir, { recursive: true });

	// Convert maxSize param to bytes.
	let maxBytes;
	if (maxSize) {
		const unit = maxSize.slice(-1);
		const size = maxSize.slice(0, -1);
		if (unit === 'G') maxBytes = size * 1000000000;
		else if (unit === 'M') maxBytes = size * 1000000;
		else maxBytes = size * 1000;
	}

	// Convert interval param to ms.
	let maxInterval;
	if (interval) {
		maxInterval = convertToMS(interval);
	}

	let lastRotatedLogPath;
	// convert date.now to minutes
	lastRotationTime = Date.now();
	hdbLogger.trace('Log rotate enabled, maxSize:', maxSize, 'interval:', interval);
	setIntervalId = setInterval(async () => {
		if (maxBytes) {
			let fileStats;
			try {
				fileStats = await fsProm.stat(logger.path);
			} catch (err) {
				// If the log file doesn't exist, skip rotation check
				if (err.code === 'ENOENT') return;
				throw err;
			}

			if (fileStats.size >= maxBytes) {
				try {
					lastRotatedLogPath = await moveLogFile(logger.path, rotatedLogDir);
				} catch (err) {
					// If the log file doesn't exist, skip rotation
					if (err.code === 'ENOENT') return;
					throw err;
				}
			}
		}

		if (maxInterval) {
			const minSinceLastRotate = Date.now() - lastRotationTime;
			if (minSinceLastRotate >= maxInterval) {
				try {
					lastRotatedLogPath = await moveLogFile(logger.path, rotatedLogDir);
					lastRotationTime = Date.now();
				} catch (err) {
					// If the log file doesn't exist, skip rotation
					if (err.code === 'ENOENT') return;
					throw err;
				}
			}
		}
		if (retention || reclamationPriority) {
			// remove old logs after retention time
			// adjust retention time if there is a reclamation priority in place
			const retentionMs = convertToMS(retention ?? '1M') / (1 + reclamationPriority);
			reclamationPriority = 0; // reset it after use
			const files = await fsProm.readdir(rotatedLogDir);
			for (const file of files) {
				try {
					const fileStats = await fsProm.stat(path.join(rotatedLogDir, file));
					if (Date.now() - fileStats.mtimeMs > retentionMs) {
						await fsProm.unlink(path.join(rotatedLogDir, file));
					}
				} catch (err) {
					hdbLogger.error('Error trying to remove log', file, err);
				}
			}
		}
	}, auditInterval ?? LOG_AUDIT_INTERVAL).unref();
	return {
		end() {
			clearInterval(setIntervalId);
		},
		getLastRotatedLogPath() {
			return lastRotatedLogPath;
		},
	};
}

async function moveLogFile(logPath: string, rotatedLogPath: string) {
	const compress = envMgr.get(CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS);
	let fullRotateLogPath = path.join(
		rotatedLogPath,
		`HDB-${new Date(Date.now()).toISOString().replaceAll(':', '-')}.log`
	);
	// Move log file to rotated log path first (if we crash
	// during compression, we don't want to restart the compression with a new file)
	await fsProm.rename(logPath, fullRotateLogPath);
	if (compress) {
		logPath = fullRotateLogPath;
		fullRotateLogPath += '.gz';
		await pipe(createReadStream(logPath), createGzip(), createWriteStream(fullRotateLogPath));
		await fsProm.unlink(logPath);
	}

	// Close old log file.
	hdbLogger.closeLogFile();
	// This notify log will create a new log file after the previous one has been rotated. It's important to keep this log as notify
	hdbLogger.notify(`hdb.log rotated, old log moved to ${fullRotateLogPath}`);
	return fullRotateLogPath;
}
