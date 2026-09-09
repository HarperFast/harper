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

// Bounds each writer's blind window at one quantum plus the flush that crosses it, so the file is
// bounded by maxBytes + T * (quantum + batch) rather than by elapsed time. Fixed, not a remaining
// budget: a budget assumes one thread's stat accounts for the other threads' future bytes.
const CHECK_QUANTUM_DIVISOR = 16;
const ROTATION_RETRY_COOLDOWN = 5000;
const SIZE_UNIT_MULTIPLIERS = { K: 1e3, M: 1e6, G: 1e9 };

export const INVALID_MAX_SIZE_MSG = "'maxSize' must be a positive size with a K, M or G unit (for example '64M')";

/**
 * Convert `logging.rotation.maxSize` to bytes, or undefined if it cannot be a byte limit. One
 * definition, shared with validation/configValidator.ts.
 */
export function parseMaxSize(maxSize: any) {
	if (typeof maxSize !== 'string') return undefined;
	const multiplier = SIZE_UNIT_MULTIPLIERS[maxSize.slice(-1)];
	if (!multiplier) return undefined;
	const size = maxSize.slice(0, -1);
	// Number(), not a stricter grammar, so every mantissa that yields a usable cap today keeps working.
	if (size.trim() === '') return undefined;
	const bytes = Number(size) * multiplier;
	return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

export function resolveRotatedLogDir(logPath: string, configuredPath?: string) {
	return configuredPath || join(dirname(logPath), 'rotated');
}

// threadId is load-bearing in the suffix below: worker threads share the process pid, and this
// counter is per-isolate, so pid+seq alone cannot keep two threads' archives apart.
let rotationSequence = 0;

// A configured rotation path may also contain live logs, so destructive scans must identify archives.
const ARCHIVE_NAME = /-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-\d+-\d+-\d+\.log(\.gz)?$/;

export function isArchiveName(file: string) {
	return ARCHIVE_NAME.test(file);
}

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
	// From the archive, not from the stat above: another isolate can rotate this generation away and
	// its sink recreate the pathname between the two, and then this rename moves an inode the earlier
	// stat never saw. Announcing that stat's identity would name a generation nobody holds, so every
	// peer would answer "released" while still appending to the one about to be destroyed.
	let { ino, dev } = active;
	try {
		({ ino, dev } = statSync(archivePath));
	} catch {
		// Already claimed by retention or another pass; the pre-rename identity is the best available.
	}
	return { logPath, archivePath, ino, dev, generation: nextGenerationId() };
}

/**
 * Publish an archived generation: ask every enumerable in-process peer to release it, then compress
 * it if requested. The plain archive is only unlinked once that release is proven.
 */
export async function publishArchivedGeneration(
	generation: any,
	compress?: boolean,
	reportCompressionError?: (error: any) => void
) {
	if (!(await requestGenerationClose(generation))) {
		rememberUnprovenArchive(generation.archivePath, { generation, compress });
		return generation.archivePath;
	}
	if (compress) {
		try {
			return await compressArchive(generation.archivePath);
		} catch (error) {
			reportCompressionError?.(error);
		}
	}
	return generation.archivePath;
}

// A compression retry queue, not the safety mechanism — safety is the release the tick proves before
// anything is destroyed. Bounded because rotation happens mostly in workers, which run no tick to
// drain it, and because the archives are found on disk anyway.
const MAX_UNPROVEN_ARCHIVES = 64;
const unprovenArchives = new Map<string, any>();

function rememberUnprovenArchive(archivePath: string, pending: any) {
	unprovenArchives.set(archivePath, pending);
	while (unprovenArchives.size > MAX_UNPROVEN_ARCHIVES) {
		unprovenArchives.delete(unprovenArchives.keys().next().value);
	}
}

export function isArchivePendingQuiescence(archivePath: string) {
	return unprovenArchives.has(archivePath);
}

// Bounded per pass: a peer that never answers must not let the retry queue starve the audit work.
const MAX_RETRIES_PER_PASS = 4;

export async function retryPendingGenerations(options: any = {}) {
	const { deadline = Infinity, shouldStop = () => false } = options;
	let attempts = 0;
	for (const [archivePath, pending] of [...unprovenArchives]) {
		if (shouldStop() || Date.now() >= deadline) return;
		if (attempts++ >= MAX_RETRIES_PER_PASS) return;
		if (!existsSync(archivePath)) {
			unprovenArchives.delete(archivePath);
			continue;
		}
		if (!(await requestGenerationClose(pending.generation, deadline))) continue;
		unprovenArchives.delete(archivePath);
		// One archive that will not compress must not stop the rest of the queue.
		if (pending.compress) await compressArchive(archivePath).catch(() => {});
	}
}

/**
 * Compress archives left plain by any isolate, from a listing taken before quiescence was proven.
 * Write-path rotations happen mostly in the HTTP workers, whose unproven-archive bookkeeping the
 * main thread cannot see, so without this a worker's archive would silently stay uncompressed for
 * the life of the process however the operator configured `compress`.
 * Only safe to call once quiescence has been proven for exactly this listing.
 */
export async function compressPendingArchives(
	rotatedLogDir: string,
	files: string[],
	liveLogPaths: Set<string>,
	options: any = {}
) {
	const { deadline = Infinity, shouldStop = () => false } = options;
	const present = new Set(files);
	let firstError;
	for (const file of files) {
		if (shouldStop() || Date.now() >= deadline) break;
		if (!file.endsWith('.log') || !isArchiveName(file)) continue;
		const archivePath = join(rotatedLogDir, file);
		if (liveLogPaths.has(resolve(archivePath)) || unprovenArchives.has(archivePath)) continue;
		try {
			if (present.has(`${file}.gz`)) {
				// Both representations of one generation: a crash between the .gz rename and the source
				// unlink leaves the plain copy behind, and every later pass skipped it as already done, so
				// it survived until retention aged it out — or forever, retention being unset by default.
				// The .gz is renamed into place whole, and this pass already proved every peer released it.
				await fsProm.unlink(archivePath);
				continue;
			}
			const result = await tryCompressArchive(archivePath);
			if (!result.compressed) break;
		} catch (error) {
			if (error.code !== 'ENOENT' && !firstError) firstError = { error, file };
		}
	}
	return firstError;
}

// One compression at a time per rotated directory. A small maxSize on a busy instance rotates
// hundreds of times a second, and a pipeline per rotation would exhaust descriptors and memory long
// before retention could run.
const compressionByDirectory = new Map<string, Promise<any>>();

export async function compressArchive(archivePath: string) {
	return (await tryCompressArchive(archivePath)).path;
}

async function tryCompressArchive(archivePath: string) {
	const directory = dirname(archivePath);
	// Declined rather than queued: chaining would grow an unbounded list of pending jobs whenever
	// rotation outruns gzip. The archive is left for the tick's bounded sweep, which is where an
	// uncompressed rotation leaves it anyway. The slot is released by the promise this returns, not by
	// a detached continuation, because that sweep awaits each call before making the next.
	if (compressionByDirectory.has(directory)) return { path: archivePath, compressed: false };
	const chain: Promise<any> = compressOneArchive(archivePath).finally(() => {
		if (compressionByDirectory.get(directory) === chain) compressionByDirectory.delete(directory);
	});
	compressionByDirectory.set(directory, chain);
	return { path: await chain, compressed: true };
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
	const logDir = dirname(logPath);
	mkdirSync(rotatedLogDir, { recursive: true });
	// The sink creates this one lazily, on the first append that gets ENOENT, and rotatedLogDir is not
	// always under it — so without this the stat below throws ENOENT on a directory that is about to
	// exist, and rotation stays off for the life of the process.
	mkdirSync(logDir, { recursive: true });
	// Rotation is a rename, and a rename across devices can never succeed. Refusing to build the guard
	// here turns a misconfiguration that would otherwise fail closed on every write — ending file
	// logging for the life of the process — into one startup error and today's unrotated behavior.
	if (statSync(rotatedLogDir).dev !== statSync(logDir).dev) {
		throw new Error(`the rotation directory ${rotatedLogDir} is on a different filesystem than ${logPath}`);
	}
	let bytesUntilCheck = checkQuantum;
	let retryAfter = 0;
	let rotationPending = false;
	let rotating = false;
	try {
		// Seeded from the file as it actually is, so an instance restarted onto an already-oversized
		// log rotates on its first write rather than on the first audit tick a minute later.
		bytesUntilCheck = Math.min(checkQuantum, Math.max(0, maxBytes - statSync(logPath).size));
	} catch {
		// No log file yet.
	}
	return { beforeAppend, recordWrite, checkQuantum };

	/**
	 * Try a pending rotation before the next append. A failed rotation leaves the active file
	 * writable: daemonized services discard stdio, so refusing the append would silently lose logs.
	 */
	function beforeAppend() {
		// `rotating` first: the rotation notice is written back through this same sink, and it must
		// not re-enter a rotation that has not finished setting its own state.
		if (rotating || !rotationPending) return true;
		if (retryAfter > performance.now()) return true;
		attemptRotation();
		// If rotation is still unavailable, preserving records in the writable active log is safer
		// than silently dropping them (scripted services have no stdio fallback).
		return true;
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
			// rename() reports ENOENT for a missing source AND for a missing destination directory, and
			// only the first is benign. A missing source is the normal multi-writer outcome: another
			// thread (or the audit tick) renamed the generation between this thread's stat and its
			// rename, so the file is under the cap now, which is all this check wanted. A missing
			// destination means no rotation can ever succeed, and treating that as a race would clear
			// the cap check on every pass and let the log grow without a bound or a diagnostic. The
			// destination is what is asked about: a peer can recreate the source pathname between the
			// failed rename and this check, which would make the benign case look like the fatal one.
			if (error.code === 'ENOENT' && existsSync(rotatedLogDir)) {
				closeLogFile();
				rotationPending = false;
				return;
			}
			rotationPending = true;
			retryAfter = performance.now() + ROTATION_RETRY_COOLDOWN;
			closeLogFile();
			report(`Harper cannot rotate its log file: ${error}`);
			// A rotation target removed under a running instance is recoverable; recreate it here rather
			// than on every rotation, so the common path keeps costing one stat and one rename.
			if (error.code === 'ENOENT') {
				try {
					mkdirSync(rotatedLogDir, { recursive: true });
				} catch {
					// Reported above already; the retry will fail the same way and report again.
				}
			}
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
		publishArchivedGeneration(generation, compress, (error) =>
			report(`Harper could not compress a rotated log file: ${error}`)
		).catch((error) => report(`Harper could not publish a rotated log file: ${error}`));
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
