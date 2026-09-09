'use strict';

import { existsSync, mkdirSync, statSync, promises as fsProm } from 'fs';
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
	let ended = false;
	let releaseProofStalled = false;
	const auditIntervalMs = auditInterval ?? LOG_AUDIT_INTERVAL;
	const compressionBudgetMs = Math.max(1, Math.floor(auditIntervalMs / 4));
	/**
	 * rename() reports ENOENT for a missing destination directory as well as a missing source, and
	 * only the second is the benign lost race. The directory is created once at rotator start, so a
	 * rotation target removed under a running instance otherwise stops rotation permanently and
	 * silently — and with `interval` and no `maxSize` there is no write-path guard to recreate it.
	 */
	function recoverRotationTarget(err: any) {
		if (err.code !== 'ENOENT' || existsSync(rotatedLogDir)) return;
		try {
			mkdirSync(rotatedLogDir, { recursive: true });
			hdbLogger.warn(`The log rotation directory ${rotatedLogDir} was missing and has been recreated`);
		} catch (mkdirErr) {
			hdbLogger.error('Could not recreate the log rotation directory', rotatedLogDir, mkdirErr);
		}
	}
	const setIntervalId = setInterval(async () => {
		// setInterval does not await the callback, and one pass can now wait on peers; overlapping
		// passes would work the same archive twice and double-compress it.
		if (tickInFlight || ended) return;
		tickInFlight = true;
		const tickDeadline = Date.now() + auditIntervalMs;
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
						lastRotatedLogPath = await moveLogFile(logger.path, rotatedLogDir, logger, compressArchives, active);
						// The interval clock counts from the last rotation of any kind. Without this an
						// instance whose uptime has passed `interval` archives a freshly-created log every
						// interval on top of the size rotations already doing the work.
						lastRotationTime = Date.now();
					}
				} catch (err) {
					// A missing or already-rotated active log only invalidates this check; retention below
					// must still run, so skip the check rather than leaving the whole tick.
					recoverRotationTarget(err);
					if (err.code !== 'ENOENT') throw err;
				}
			}

			if (maxInterval) {
				// Whichever origin is older. birthtime is unsupported on some filesystems, where it mirrors
				// a write-updated ctime and would postpone interval rotation forever; taking the minimum
				// means this can only ever rotate at least as often as the counter alone did.
				let generationStartedAt = lastRotationTime;
				try {
					const born = statSync(logger.path).birthtimeMs;
					if (born > 0) generationStartedAt = Math.min(generationStartedAt, born);
				} catch (err) {
					if (err.code !== 'ENOENT') throw err;
				}
				if (Date.now() - generationStartedAt >= maxInterval) {
					try {
						lastRotatedLogPath = await moveLogFile(logger.path, rotatedLogDir, logger, compressArchives);
						lastRotationTime = Date.now();
					} catch (err) {
						// If the log file doesn't exist, skip rotation
						recoverRotationTarget(err);
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
				const { released, liveLogPaths } = await requestStaleDescriptorRelease(tickDeadline);
				// A peer whose event loop is blocked never answers, and the whole pass then destroys
				// nothing — correct, but it is also the only thing bounding the rotated directory, so an
				// operator who configured retention has to be able to see that it has stopped. Latched
				// rather than repeated, so a permanently stalled peer reports once per stall.
				if (!released && !releaseProofStalled) {
					releaseProofStalled = true;
					hdbLogger.warn(
						`Log rotation could not prove every thread released its archived log descriptors; compression and retention are paused for ${rotatedLogDir}`
					);
				} else if (released && releaseProofStalled) {
					releaseProofStalled = false;
					hdbLogger.notify(`Log rotation descriptor release recovered; retention resumed for ${rotatedLogDir}`);
				}
				const liveLogs = new Set([...liveLogPaths, logger.path].map((p) => path.resolve(p)));

				if (released && (retention || reclamationPriority)) {
					// remove old logs after retention time
					// adjust retention time if there is a reclamation priority in place
					const retentionMs = convertToMS(retention ?? '1M') / (1 + reclamationPriority);
					let retentionCompleted = true;
					for (const file of candidates) {
						if (ended || Date.now() >= tickDeadline) {
							retentionCompleted = false;
							break;
						}
						try {
							const archivePath = path.join(rotatedLogDir, file);
							// An explicitly configured rotation path may contain live component logs too.
							if (liveLogs.has(path.resolve(archivePath))) continue;
							// Unlinking an inode a stalled writer still holds loses whatever it writes next
							// just as surely as compressing over it would.
							if (isArchivePendingQuiescence(archivePath)) continue;
							const fileStats = await fsProm.stat(archivePath);
							if (Date.now() - fileStats.mtimeMs > retentionMs) {
								await fsProm.unlink(archivePath);
							}
						} catch (err) {
							if (err.code !== 'ENOENT') hdbLogger.error('Error trying to remove log', file, err);
						}
					}
					if (retentionCompleted) reclamationPriority = 0;
				}

				if (released && compressArchives && !ended) {
					const compressionFailure = await compressPendingArchives(rotatedLogDir, candidates, liveLogs, {
						deadline: Math.min(tickDeadline, Date.now() + compressionBudgetMs),
						shouldStop: () => ended,
					});
					if (compressionFailure)
						hdbLogger.error('Error compressing rotated log', compressionFailure.file, compressionFailure.error);
				}
			}
		} catch (err) {
			hdbLogger.error('Error during log rotation audit tick for', logger.path, err);
		} finally {
			try {
				await retryPendingGenerations({ deadline: tickDeadline, shouldStop: () => ended });
			} catch (err) {
				hdbLogger.error('Error retrying pending log generations for', logger.path, err);
			}
			tickInFlight = false;
		}
	}, auditIntervalMs).unref();
	return {
		end() {
			ended = true;
			clearInterval(setIntervalId);
		},
		getLastRotatedLogPath() {
			return lastRotatedLogPath;
		},
	};
}

async function moveLogFile(
	logPath: string,
	rotatedLogPath: string,
	logger?: any,
	compress?: boolean,
	activeStats?: any
) {
	// The rename and the descriptor close must not be separated by an await: the descriptor would
	// otherwise keep feeding the archived inode while the event loop runs. Closing the rotating
	// logger's own descriptor (not the module-global one) is what makes the next write reopen a
	// fresh log file rather than append to the moved — and, when compressing, unlinked — inode.
	// `activeStats` is the caller's own stat of the live generation, when it has one: the size check
	// must rename the generation it measured, and a second stat here could pick up a newer one.
	const generation = rotateLogFileSync(
		logPath,
		rotatedLogPath,
		logger?.closeLogFile ?? hdbLogger.closeLogFile,
		activeStats
	);
	const publishedPath = await publishArchivedGeneration(
		generation,
		compress ?? envMgr.get(CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS)
	);

	// This notify log will create a new log file after the previous one has been rotated. It's important to keep this log as notify
	hdbLogger.notify(`hdb.log rotated, old log moved to ${publishedPath}`);
	return publishedPath;
}
