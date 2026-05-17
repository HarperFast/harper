'use strict';

import { promises as fsProm, createReadStream, createWriteStream, mkdirSync } from 'fs';
import { createGzip } from 'zlib';
import { promisify } from 'util';
import { pipeline } from 'stream';
const pipe = promisify(pipeline);
import * as path from 'path';
import * as envMgr from '../environment/environmentManager.ts';
try {
	envMgr.initSync();
} catch {
	/* tolerate ESM cycle TDZ; bin entry will re-call later */
}
import hdbLogger from './harper_logger.ts';
import { CONFIG_PARAMS } from '../hdbTerms.ts';
import { convertToMS } from '../common_utils.ts';
import { onStorageReclamation } from '../../server/storageReclamation.ts';

// Interval in ms to check log file and decide if it should be rotated.
const LOG_AUDIT_INTERVAL = 60000;
const INT_SIZE_UNDEFINED_MSG =
	"'interval' and 'maxSize' are both undefined, to enable logging rotation at least one of these values must be defined in harperdb-config.yaml";

export { logRotator };

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
	let lastRotationTime = Date.now();
	hdbLogger.trace('Log rotate enabled, maxSize:', maxSize, 'interval:', interval);
	const setIntervalId = setInterval(async () => {
		// A missing/relocated active log file only invalidates the rotation checks below — retention cleanup
		// must still run. So skip the individual check on ENOENT rather than returning from the whole tick.
		if (maxBytes) {
			let fileStats;
			try {
				fileStats = await fsProm.stat(logger.path);
			} catch (err) {
				// If the log file doesn't exist, skip the size-based rotation check
				if (err.code !== 'ENOENT') throw err;
			}

			if (fileStats && fileStats.size >= maxBytes) {
				try {
					lastRotatedLogPath = await moveLogFile(logger.path, rotatedLogDir, logger);
				} catch (err) {
					// If the log file doesn't exist, skip rotation
					if (err.code !== 'ENOENT') throw err;
				}
			}
		}

		if (maxInterval) {
			const minSinceLastRotate = Date.now() - lastRotationTime;
			if (minSinceLastRotate >= maxInterval) {
				try {
					lastRotatedLogPath = await moveLogFile(logger.path, rotatedLogDir, logger);
					lastRotationTime = Date.now();
				} catch (err) {
					// If the log file doesn't exist, skip rotation
					if (err.code !== 'ENOENT') throw err;
				}
			}
		}
		if (retention || reclamationPriority) {
			// remove old logs after retention time
			// adjust retention time if there is a reclamation priority in place
			const retentionMs = convertToMS(retention ?? '1M') / (1 + reclamationPriority);
			reclamationPriority = 0; // reset it after use
			let files;
			try {
				files = await fsProm.readdir(rotatedLogDir);
			} catch (err) {
				// The rotated log dir may not exist yet (nothing rotated so far); nothing to clean up
				if (err.code !== 'ENOENT') hdbLogger.error('Error reading rotated log directory', rotatedLogDir, err);
				files = [];
			}
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

async function moveLogFile(logPath: string, rotatedLogPath: string, logger?: any) {
	const compress = envMgr.get(CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS);
	let fullRotateLogPath = path.join(
		rotatedLogPath,
		`HDB-${new Date(Date.now()).toISOString().replaceAll(':', '-')}.log`
	);
	// Move log file to rotated log path first (if we crash
	// during compression, we don't want to restart the compression with a new file)
	await fsProm.rename(logPath, fullRotateLogPath);
	// Close the rotating logger's own file descriptor now that the file has moved. This must be the
	// logger's own closeLogFile (which resets its internal logFD), not the module-global one — otherwise
	// the descriptor stays open on the moved (and, when compressing, subsequently unlinked) inode until the
	// logger's safety timeout fires, pinning disk space and sending any writes in that window into the
	// rotated/deleted file. Closing it here makes the next write reopen a fresh log file immediately.
	(logger?.closeLogFile ?? hdbLogger.closeLogFile)();
	if (compress) {
		logPath = fullRotateLogPath;
		fullRotateLogPath += '.gz';
		await pipe(createReadStream(logPath), createGzip(), createWriteStream(fullRotateLogPath));
		await fsProm.unlink(logPath);
	}

	// This notify log will create a new log file after the previous one has been rotated. It's important to keep this log as notify
	hdbLogger.notify(`hdb.log rotated, old log moved to ${fullRotateLogPath}`);
	return fullRotateLogPath;
}
