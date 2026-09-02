'use strict';

import { mkdirSync, statSync, promises as fsProm } from 'fs';
import * as path from 'path';
import * as envMgr from '../environment/environmentManager.ts';
envMgr.initSync();
import hdbLogger from './harper_logger.ts';
import { CONFIG_PARAMS } from '../hdbTerms.ts';
import { convertToMS } from '../common_utils.ts';
import { onStorageReclamation } from '../../server/storageReclamation.ts';
import { requestStaleDescriptorRelease } from './logGenerationCoordinator.ts';
import {
	compressPendingArchives,
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
function logRotator({
	logger,
	maxSize,
	interval,
	retention,
	enabled,
	compress,
	path: rotatedLogDir,
	auditInterval,
}: any) {
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

	// The rotation block first, because that is all the write-path guard can read — environmentManager
	// imports harper_logger — and two sources would mean two destruction policies for one log.
	const compressArchives = compress ?? envMgr.get(CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS);

	// Convert interval param to ms.
	let maxInterval;
	if (interval) {
		maxInterval = convertToMS(interval);
	}

	let lastRotatedLogPath;
	// convert date.now to minutes
	let lastRotationTime = Date.now();
	hdbLogger.trace('Log rotate enabled, maxSize:', maxSize, 'interval:', interval);
	let tickInFlight = false;
	const setIntervalId = setInterval(async () => {
		// setInterval does not await the callback, and one pass can now wait on peers; overlapping
		// passes would work the same archive twice and double-compress it.
		if (tickInFlight) return;
		tickInFlight = true;
		// The tick is async but setInterval doesn't await it, so any error that escapes this callback
		// becomes an unhandled rejection rather than surfacing anywhere useful — and since it isn't
		// caught, it also skips the retention cleanup below. Contain everything here and report via
		// the logger instead, so one bad tick (e.g. an unexpected fs error) never kills rotation for
		// the rest of the process's life.
		try {
			if (maxBytes) {
				try {
					// statSync, and the rename in the same turn: an await here lets a writing thread rotate
					// the generation this tick measured and start a fresh one, which the tick would then
					// archive near-empty.
					const active = statSync(logger.path);
					if (active.size >= maxBytes) {
						const generation = rotateLogFileSync(
							logger.path,
							rotatedLogDir,
							logger?.closeLogFile ?? hdbLogger.closeLogFile,
							active
						);
						lastRotatedLogPath = await publishArchivedGeneration(generation, compressArchives);
						// The interval clock counts from the last rotation of any kind. Without this an
						// instance whose uptime has passed `interval` archives a freshly-created log every
						// interval on top of the size rotations already doing the work.
						lastRotationTime = Date.now();
						hdbLogger.notify(`hdb.log rotated, old log moved to ${lastRotatedLogPath}`);
					}
				} catch (err) {
					// A missing or already-rotated active log only invalidates this check; retention below
					// must still run, so skip the check rather than leaving the whole tick.
					if (err.code !== 'ENOENT') throw err;
				}
			}

			if (maxInterval) {
				// The current generation's own age, so a rotation by any thread — or by a previous run —
				// resets the clock, not just the ones this tick performed. birthtime is unsupported on
				// some filesystems, where this falls back to the last rotation this rotator saw.
				let generationStartedAt = lastRotationTime;
				try {
					const born = statSync(logger.path).birthtimeMs;
					if (born > 0) generationStartedAt = born;
				} catch (err) {
					if (err.code !== 'ENOENT') throw err;
				}
				if (Date.now() - generationStartedAt >= maxInterval) {
					try {
						lastRotatedLogPath = await moveLogFile(logger.path, rotatedLogDir, logger, compressArchives);
						lastRotationTime = Date.now();
					} catch (err) {
						// If the log file doesn't exist, skip rotation
						if (err.code !== 'ENOENT') throw err;
					}
				}
			}
			// The compression sweep and retention both destroy archives this thread did not rotate, so
			// both need the same proof: every peer releases any descriptor that is not on the live
			// generation, and reports the log paths it is writing. One round trip per tick serves both,
			// and it is not gated on retention being configured — retention is unset by default, and a
			// worker's uncompressed archive still needs finishing.
			if (compressArchives || retention || reclamationPriority) {
				// Enumerated BEFORE the proof, and only these are destroyed: an archive created after the
				// proof was never covered by it, and a peer blocked mid-rotation may still be writing to it.
				let candidates;
				try {
					candidates = await fsProm.readdir(rotatedLogDir);
				} catch (err) {
					if (err.code !== 'ENOENT') hdbLogger.error('Error reading rotated log directory', rotatedLogDir, err);
					candidates = [];
				}
				let activeStats;
				try {
					activeStats = statSync(logger.path);
				} catch (err) {
					if (err.code !== 'ENOENT') throw err;
				}
				const { released, liveLogPaths } = await requestStaleDescriptorRelease(logger.path, activeStats);
				liveLogPaths.add(logger.path);

				if (released && compressArchives) await compressPendingArchives(rotatedLogDir, candidates, liveLogPaths);

				if (released && (retention || reclamationPriority)) {
					// remove old logs after retention time
					// adjust retention time if there is a reclamation priority in place
					const retentionMs = convertToMS(retention ?? '1M') / (1 + reclamationPriority);
					reclamationPriority = 0; // reset it after use
					for (const file of candidates) {
						try {
							const archivePath = path.join(rotatedLogDir, file);
							// The rotated directory defaults to the log directory itself
							// (`logging.rotation.path` defaults to `log`, as does `logging.root`), so it also
							// holds the logs currently being written — including a component's, which loads in
							// a worker and is only known here because the peers reported it.
							if (liveLogPaths.has(archivePath)) continue;
							// Unlinking an inode a stalled writer still holds loses whatever it writes next
							// just as surely as compressing over it would.
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
			}
			// Last: retention is what bounds the rotated directory, so a stranded generation waiting on a
			// peer must never be ahead of it.
			await retryPendingGenerations();
		} catch (err) {
			hdbLogger.error('Error during log rotation audit tick for', logger.path, err);
		} finally {
			tickInFlight = false;
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

async function moveLogFile(logPath: string, rotatedLogPath: string, logger?: any, compress?: boolean) {
	// The rename and the descriptor close must not be separated by an await: the descriptor would
	// otherwise keep feeding the archived inode while the event loop runs. Closing the rotating
	// logger's own descriptor (not the module-global one) is what makes the next write reopen a
	// fresh log file rather than append to the moved — and, when compressing, unlinked — inode.
	const generation = rotateLogFileSync(logPath, rotatedLogPath, logger?.closeLogFile ?? hdbLogger.closeLogFile);
	const publishedPath = await publishArchivedGeneration(
		generation,
		compress ?? envMgr.get(CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS)
	);

	// This notify log will create a new log file after the previous one has been rotated. It's important to keep this log as notify
	hdbLogger.notify(`hdb.log rotated, old log moved to ${publishedPath}`);
	return publishedPath;
}
