'use strict';

// The rotation primitives the log write path needs. Kept free of every Harper import so
// harper_logger.ts can pull it in eagerly: logRotator.ts reaches server/storageReclamation.ts ->
// manageThreads.js -> harper_logger.ts, which is why it may only ever be required lazily, and a
// guard installed on a timer is a guard the first megabytes of a burst are written without.

import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	renameSync,
	statSync,
	promises as fsProm,
} from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import { nextGenerationId, requestGenerationClose } from './logGenerationCoordinator.ts';

// Each writer re-checks the file after this many bytes of its own output. Fixed, not "the remaining
// budget": a remaining budget assumes one thread's stat accounts for the other threads' future
// bytes, so T writers each seeing ~maxBytes left can add ~T * maxBytes before any of them looks
// again. A fixed quantum caps every writer's blind window at quantum + one payload regardless of
// what the others do, making the bound a function of maxSize and thread count rather than of write
// rate or scheduler delay.
const CHECK_QUANTUM_DIVISOR = 16;
const ROTATION_RETRY_COOLDOWN = 5000;
const SIZE_UNIT_MULTIPLIERS = { K: 1e3, M: 1e6, G: 1e9 };

export const INVALID_MAX_SIZE_MSG = "'maxSize' must be a positive size with a K, M or G unit (for example '64M')";

/**
 * Convert a `logging.rotation.maxSize` value to bytes, or undefined if it is not a usable size.
 * One definition, shared with validation/configValidator.ts: a value this rejects must not reach
 * the write path, where a zero/negative/NaN limit would trip the size check on every flush.
 */
export function parseMaxSize(maxSize: any) {
	if (typeof maxSize !== 'string') return undefined;
	const multiplier = SIZE_UNIT_MULTIPLIERS[maxSize.slice(-1)];
	if (!multiplier) return undefined;
	const size = maxSize.slice(0, -1);
	// Number(), not a stricter grammar: every mantissa that produces a usable cap today keeps
	// working, exponent notation included. What is rejected is only what cannot be a cap at all —
	// `parseInt` accepted '0K', '-1K' and '1xK', which become a limit of 0, a negative number, and
	// NaN. Sampled once a minute those merely misbehave; on the write path they are checked per flush.
	if (size.trim() === '') return undefined;
	const bytes = Number(size) * multiplier;
	return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

export function resolveRotatedLogDir(logPath: string, configuredPath?: string) {
	return configuredPath || join(dirname(logPath), 'rotated');
}

// Monotonically increasing across every rotation in this isolate; combined with the pid and thread
// id this guarantees two archive names cannot collide even when two threads rotate two different
// sources within the same millisecond. threadId is load-bearing now that any writing thread can
// rotate: worker threads share the process's pid, and this counter is per-isolate module state.
let rotationSequence = 0;

export function archivePathFor(logPath: string, rotatedLogDir: string) {
	// Name the archive after its source log (hdb, external, a component name, ...), not a fixed
	// "HDB" literal — external/component loggers inherit rotation from the main logger (#1877) and
	// default to the same rotated directory. A basename alone is not enough either: two distinct
	// source paths can share one (`/logs/a/hdb.log`, `/logs/b/hdb.log`), so a hash of the resolved
	// source path plus the unique suffix give every archive a name rename() can never clobber.
	const sourceName = basename(logPath, extname(logPath)) || 'HDB';
	// sha256, not sha1: this only needs a stable identifier, but a FIPS-mode OpenSSL provider
	// disables sha1 and throws synchronously, which would crash every rotation.
	const sourceId = createHash('sha256').update(resolve(logPath)).digest('hex').slice(0, 8);
	const uniqueSuffix = `${process.pid}-${threadId}-${rotationSequence++}`;
	const timestamp = new Date().toISOString().replaceAll(':', '-');
	return join(rotatedLogDir, `${sourceName}-${sourceId}-${timestamp}-${uniqueSuffix}.log`);
}

/**
 * Move the active log aside and release this isolate's descriptor, with nothing awaited in between:
 * a rotation that yields to the event loop lets the logging loop that triggered it keep appending,
 * which is the rate-dependent overshoot this whole change exists to remove.
 */
export function rotateLogFileSync(logPath: string, rotatedLogDir: string, closeLogFile: () => void, activeStats?: any) {
	const active = activeStats ?? statSync(logPath);
	const archivePath = archivePathFor(logPath, rotatedLogDir);
	renameSync(logPath, archivePath);
	closeLogFile();
	return { logPath, archivePath, ino: active.ino, dev: active.dev, generation: nextGenerationId() };
}

/**
 * Publish an archived generation: tell every other writer to release it, then compress it if asked.
 * The plain archive is only ever unlinked once that release is proven — an unlinked inode a peer is
 * still appending to loses those records outright, and no size comparison can rule that out.
 */
export async function publishArchivedGeneration(generation: any, compress?: boolean) {
	if (!(await requestGenerationClose(generation))) {
		unprovenArchives.set(generation.archivePath, { generation, compress });
		return generation.archivePath;
	}
	return compress ? compressArchive(generation.archivePath) : generation.archivePath;
}

// Generations this process archived but could not prove released. Tracked whether or not they are
// to be compressed: retention unlinks archives too, and unlinking an inode a stalled writer still
// holds loses whatever it writes next just as surely as gzip would.
const unprovenArchives = new Map<string, any>();

export function isArchivePendingQuiescence(archivePath: string) {
	return unprovenArchives.has(archivePath);
}

export async function retryPendingGenerations() {
	for (const [archivePath, pending] of [...unprovenArchives]) {
		if (!existsSync(archivePath)) {
			unprovenArchives.delete(archivePath);
			continue;
		}
		if (!(await requestGenerationClose(pending.generation))) continue;
		unprovenArchives.delete(archivePath);
		if (pending.compress) await compressArchive(archivePath);
	}
}

// One compression at a time per rotated directory. A small maxSize on a busy instance rotates
// hundreds of times a second, and a pipeline per rotation would exhaust descriptors and memory long
// before retention could run. Nothing is queued in memory: whatever this pass does not reach stays
// on disk as a plain archive, which is what an uncompressed rotation leaves anyway.
const compressionByDirectory = new Map<string, Promise<any>>();

export function compressArchive(archivePath: string) {
	const directory = dirname(archivePath);
	const previous = compressionByDirectory.get(directory) ?? Promise.resolve();
	const chain = previous.then(
		() => compressOneArchive(archivePath),
		() => compressOneArchive(archivePath)
	);
	compressionByDirectory.set(directory, chain);
	chain
		.catch(() => {})
		.then(() => {
			if (compressionByDirectory.get(directory) === chain) compressionByDirectory.delete(directory);
		});
	return chain;
}

async function compressOneArchive(archivePath: string) {
	const compressedPath = `${archivePath}.gz`;
	// Written to a temp file and renamed into place, so a crash mid-gzip can never leave a truncated
	// `.gz` looking like the authoritative copy of a generation.
	const temporaryPath = `${compressedPath}.${process.pid}-${threadId}-${rotationSequence++}.tmp`;
	try {
		await pipeline(createReadStream(archivePath), createGzip(), createWriteStream(temporaryPath));
		await fsProm.rename(temporaryPath, compressedPath);
	} catch (error) {
		await fsProm.unlink(temporaryPath).catch(() => {});
		throw error;
	}
	await fsProm.unlink(archivePath);
	return compressedPath;
}

/**
 * The write-path size guard. One subtraction and one branch per flush; one pathname stat once per
 * quantum of this writer's own output.
 */
export function createRotationGuard(options: any) {
	const { logPath, maxBytes, rotatedLogDir, compress, getLogIdentity, closeLogFile, report, onRotated } = options;
	const checkQuantum = Math.max(1, Math.floor(maxBytes / CHECK_QUANTUM_DIVISOR));
	mkdirSync(rotatedLogDir, { recursive: true });
	let bytesUntilCheck = checkQuantum;
	let retryAfter = 0;
	let rotationPending = false;
	let rotating = false;
	try {
		// Seeded from the file as it actually is, so an instance restarted onto an already-oversized
		// log rotates on its first write rather than on the first audit tick a minute later.
		bytesUntilCheck = Math.min(checkQuantum, Math.max(0, maxBytes - statSync(logPath).size));
	} catch {
		// No log file yet; a full quantum is the right first window.
	}
	return { beforeAppend, recordWrite, checkQuantum };

	/**
	 * Whether the file may be appended to. Once the cap is known to be exceeded and rotation has
	 * failed, the answer stays no: appending anyway would make the overshoot a function of the write
	 * rate again, which is the failure this change exists to remove. Recovery is retried here, before
	 * a write, rather than after one — the sink is on stdio in the meantime, so no append would come.
	 */
	function beforeAppend() {
		// `rotating` first: the rotation notice is written back through this same sink, and it must
		// not re-enter a rotation that has not finished setting its own state.
		if (rotating || !rotationPending) return true;
		if (retryAfter > performance.now()) return false;
		attemptRotation();
		return !rotationPending;
	}

	function recordWrite(byteLength: number) {
		bytesUntilCheck -= byteLength;
		if (bytesUntilCheck > 0) return;
		bytesUntilCheck = checkQuantum;
		// `rotating` covers the rotation notice, which is written back through this same sink.
		if (rotating || retryAfter > performance.now()) return;
		attemptRotation();
	}

	function attemptRotation() {
		rotating = true;
		try {
			checkAndRotate();
			rotationPending = false;
		} catch (error) {
			rotationPending = true;
			retryAfter = performance.now() + ROTATION_RETRY_COOLDOWN;
			closeLogFile();
			report(`Harper cannot rotate its log file: ${error}`);
		} finally {
			rotating = false;
		}
	}

	function checkAndRotate() {
		let active;
		try {
			active = statSync(logPath);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
			// The generation this descriptor belongs to has already been rotated away by someone else.
			closeLogFile();
			return;
		}
		// The descriptor's identity is cached when it is opened, so the common checkpoint costs this
		// one pathname stat rather than a stat plus an fstat.
		if (!holdsGeneration(active)) {
			closeLogFile();
			return;
		}
		if (active.size < maxBytes) return;
		const generation = rotateLogFileSync(logPath, rotatedLogDir, closeLogFile, active);
		onRotated?.(generation.archivePath);
		publishArchivedGeneration(generation, compress).catch((error) =>
			report(`Harper could not compress a rotated log file: ${error}`)
		);
	}

	function holdsGeneration(active: any) {
		const identity = getLogIdentity();
		if (!identity) return true;
		// Some Windows filesystems report an unstable or zero ino, where identity cannot distinguish
		// generations; there this defers to the size check rather than closing a descriptor at random.
		if (identity.ino === 0 || active.ino === 0) return true;
		return identity.ino === active.ino && identity.dev === active.dev;
	}
}
