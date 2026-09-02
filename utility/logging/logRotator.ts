'use strict';

import { mkdirSync, promises as fsProm } from 'fs';
import * as path from 'path';
import * as envMgr from '../environment/environmentManager.ts';
envMgr.initSync();
import hdbLogger from './harper_logger.ts';
import { CONFIG_PARAMS } from '../hdbTerms.ts';
import { convertToMS } from '../common_utils.ts';
import { onStorageReclamation } from '../../server/storageReclamation.ts';
import {
	INVALID_MAX_SIZE_MSG,
	isArchivePendingQuiescence,
	parseMaxSize,
	publishArchivedGeneration,
	resolveRotatedLogDir,
	retryPendingGenerations,
	rotateLogFileSync,
} from './logRotation.ts';

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

	rotatedLogDir = resolveRotatedLogDir(logger.path, rotatedLogDir);
	mkdirSync(rotatedLogDir, { recursive: true });

	const maxBytes = parseMaxSize(maxSize);
	if (maxSize && !maxBytes) {
		hdbLogger.error(`Ignoring logging.rotation.maxSize '${maxSize}': ${INVALID_MAX_SIZE_MSG}`);
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
		// The tick is async but setInterval doesn't await it, so any error that escapes this callback
		// becomes an unhandled rejection rather than surfacing anywhere useful — and since it isn't
		// caught, it also skips the retention cleanup below. Contain everything here and report via
		// the logger instead, so one bad tick (e.g. an unexpected fs error) never kills rotation for
		// the rest of the process's life.
		try {
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
			// A generation this process could not prove released is retried here rather than abandoned:
			// the tick is the only recurring opportunity to compress it, and it must happen before
			// retention below, which would otherwise be the thing that unlinks it.
			await retryPendingGenerations();

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
						const archivePath = path.join(rotatedLogDir, file);
						// Unlinking an inode a stalled writer still holds loses whatever it writes next
						// just as surely as compressing over it would, so retention waits for the same proof.
						if (isArchivePendingQuiescence(archivePath)) continue;
						const fileStats = await fsProm.stat(archivePath);
						if (Date.now() - fileStats.mtimeMs > retentionMs) {
							await fsProm.unlink(archivePath);
						}
					} catch (err) {
						hdbLogger.error('Error trying to remove log', file, err);
					}
				}
			}
		} catch (err) {
			hdbLogger.error('Error during log rotation audit tick for', logger.path, err);
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
	// The rename and the descriptor close must not be separated by an await: the descriptor would
	// otherwise keep feeding the archived inode while the event loop runs. Closing the rotating
	// logger's own descriptor (not the module-global one) is what makes the next write reopen a
	// fresh log file rather than append to the moved — and, when compressing, unlinked — inode.
	const generation = rotateLogFileSync(logPath, rotatedLogPath, logger?.closeLogFile ?? hdbLogger.closeLogFile);
	const publishedPath = await publishArchivedGeneration(
		generation,
		envMgr.get(CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS)
	);

	// This notify log will create a new log file after the previous one has been rotated. It's important to keep this log as notify
	hdbLogger.notify(`hdb.log rotated, old log moved to ${publishedPath}`);
	return publishedPath;
}
