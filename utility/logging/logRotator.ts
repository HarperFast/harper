'use strict';

import { promises as fsProm, createReadStream, createWriteStream, mkdirSync } from 'fs';
import { createGzip } from 'zlib';
import { promisify } from 'util';
import { pipeline } from 'stream';
const pipe = promisify(pipeline);
import * as path from 'path';
import { createHash } from 'crypto';
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

// Monotonically increasing across every rotation in this process, regardless of which logger/source
// triggered it — combined with the pid, this guarantees two archive names can never collide even if
// two rotations for two different sources race concurrently within the same audit-interval tick.
let rotationSequence = 0;

async function moveLogFile(logPath: string, rotatedLogPath: string, logger?: any) {
	const compress = envMgr.get(CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS);
	// Name the archive after its source log (hdb, external, a component name, ...), not a fixed
	// "HDB" literal — external/component loggers can now inherit rotation from the main logger
	// (#1877) and default to the same rotated directory as it, so distinct sources rotating in
	// the same audit tick must not collide on the same timestamp-only filename. A basename alone
	// is not enough either: two distinct source paths can share a basename (e.g. `/logs/a/hdb.log`
	// and `/logs/b/hdb.log`), so a hash of the full resolved source path plus a pid+sequence suffix
	// give every archive a name POSIX rename() can never clobber, even under a same-millisecond race.
	const sourceName = path.basename(logPath, path.extname(logPath)) || 'HDB';
	// sha256, not sha1: this only needs a stable identifier, not cryptographic strength, but a FIPS-mode
	// OpenSSL provider disables sha1 and throws synchronously, which would crash every rotation tick.
	const sourceId = createHash('sha256').update(path.resolve(logPath)).digest('hex').slice(0, 8);
	const uniqueSuffix = `${process.pid}-${rotationSequence++}`;
	let fullRotateLogPath = path.join(
		rotatedLogPath,
		`${sourceName}-${sourceId}-${new Date(Date.now()).toISOString().replaceAll(':', '-')}-${uniqueSuffix}.log`
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
