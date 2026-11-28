/**
 * One archive extraction at a time per instance, so the free space an extraction samples when it starts
 * already excludes every earlier upload's bytes. A file created exclusively, not an flock: an flock
 * taken on an HTTP worker would be stranded by the worker restarts a deploy performs.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { ClientError } from '../utility/errors/hdbError.ts';
import { getHdbBasePath } from '../utility/environment/environmentManager.ts';
import { processIncarnation } from '../server/threads/processIncarnation.ts';
import logger from '../utility/logging/harper_logger.ts';
import { RESTORE_RECEIPT_SUFFIX, readRestoreReceiptFile } from './restoreReceipt.ts';

const EXTRACTION_LOCK_FILE = '.restore-extraction.lock';
const RECLAIM_MARKER_INFIX = '.reclaim-';
const TEMP_SUFFIX = '.tmp';
/** The suffix of the directory holding a database's staging areas, beside its receipt; see archiveStaging.ts. */
const STAGED_SUFFIX = '.staged';

interface ExtractionLockOwner {
	incarnation: string | undefined;
	thread_id: number;
	pid: number;
	staging_id: string;
	/** Every directory this extraction may create, the engine's first, so whoever finds it abandoned can remove them. */
	areas: string[];
}

export function extractionLockPath(): string {
	return join(getHdbBasePath(), EXTRACTION_LOCK_FILE);
}

function readOwner(path: string): ExtractionLockOwner | undefined {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

function processAlive(pid: unknown): boolean {
	if (!Number.isInteger(pid)) return false;
	try {
		process.kill(pid as number, 0);
		return true;
	} catch (error: any) {
		return error?.code === 'EPERM';
	}
}

function staleOwner(owner: ExtractionLockOwner | undefined): boolean {
	return owner !== undefined && owner.incarnation !== processIncarnation && !processAlive(owner.pid);
}

function sameOwner(a: ExtractionLockOwner | undefined, b: ExtractionLockOwner): boolean {
	return a?.staging_id === b.staging_id && a.incarnation === b.incarnation && a.pid === b.pid;
}

/** Linked into place whole, so the lock never exists without its owner in it. */
function createLock(path: string, owner: ExtractionLockOwner): void {
	const temp = `${path}.${process.pid}-${threadId}-${randomUUID()}${TEMP_SUFFIX}`;
	try {
		writeFileSync(temp, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
		linkSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

function reclaimMarkerPath(path: string, stale: ExtractionLockOwner): string {
	const id = createHash('sha256')
		.update(JSON.stringify([stale.incarnation, stale.pid, stale.staging_id]))
		.digest('hex')
		.slice(0, 32);
	return path + RECLAIM_MARKER_INFIX + id;
}

/**
 * Takes over a stale lock. Only the contender that creates the reclaim marker named for that owner may
 * remove it, and only if the lock still names that owner once the marker is held: removal by a second
 * contender would delete the first one's new lock.
 */
async function reclaimStaleLock(path: string, stale: ExtractionLockOwner): Promise<void> {
	const marker = reclaimMarkerPath(path, stale);
	try {
		writeFileSync(marker, String(process.pid), { flag: 'wx', mode: 0o600 });
	} catch (error: any) {
		if (error?.code !== 'EEXIST') throw error;
		throw new ClientError(
			'Another restore is clearing an abandoned archive extraction on this instance; retry shortly. If no restore is running, starting Harper clears it',
			409
		);
	}
	try {
		if (!sameOwner(readOwner(path), stale)) return;
		await removeAbandonedAreas(stale);
		rmSync(path, { force: true });
	} finally {
		rmSync(marker, { force: true });
	}
}

export async function acquireExtractionLock(stagingId: string, areas: string[]): Promise<() => void> {
	const path = extractionLockPath();
	const owner: ExtractionLockOwner = {
		incarnation: processIncarnation,
		thread_id: threadId,
		pid: process.pid,
		staging_id: stagingId,
		areas,
	};
	for (let attempt = 0; ; attempt++) {
		try {
			createLock(path, owner);
			break;
		} catch (error: any) {
			if (error?.code !== 'EEXIST' || attempt > 0) throw refusal(error);
			const held = readOwner(path);
			if (!staleOwner(held)) throw refusal(error);
			await reclaimStaleLock(path, held!);
		}
	}
	return () => {
		if (readOwner(path)?.staging_id === stagingId) rmSync(path, { force: true });
	};
}

function refusal(error: any): Error {
	if (error?.code !== 'EEXIST') return error;
	return new ClientError(
		'Another archive is being uploaded for a restore on this instance; retry once its upload finishes',
		409
	);
}

/** Whether a restore receipt names the staging, or cannot be read and so might. */
function receiptHolds(engineArea: string): boolean {
	const stagedDir = dirname(engineArea);
	if (!basename(stagedDir).endsWith(STAGED_SUFFIX)) return false;
	const receiptPath = join(
		dirname(stagedDir),
		basename(stagedDir).slice(0, -STAGED_SUFFIX.length) + RESTORE_RECEIPT_SUFFIX
	);
	const read = readRestoreReceiptFile(receiptPath);
	if (read.kind === 'absent') return false;
	if (read.kind === 'unreadable') return true;
	return [read.receipt.staging_dir, ...(read.receipt.superseded_staging_dirs ?? [])].includes(engineArea);
}

/** Every part of the extraction, or none: only the engine area holds the record, so parts are never judged alone. */
async function removeAbandonedAreas(owner: ExtractionLockOwner | undefined): Promise<void> {
	const areas = (owner?.areas ?? []).filter((area) => typeof area === 'string');
	if (areas.length === 0 || receiptHolds(areas[0])) return;
	const { removeStagingArea } = await import('./archiveStaging.ts');
	await removeStagingArea(areas);
}

/**
 * On the main thread, when a thread exits: the extraction it held, and the areas that extraction left.
 * The lock is released only once they are gone, so no new extraction samples space they still hold.
 */
export async function releaseExtractionOfExitedThread(exitedThreadId: number): Promise<void> {
	const path = extractionLockPath();
	if (!existsSync(path)) return;
	const owner = readOwner(path);
	if (owner?.incarnation !== processIncarnation || owner.thread_id !== exitedThreadId) return;
	await removeAbandonedAreas(owner);
	try {
		unlinkSync(path);
	} catch (error: any) {
		if (error?.code !== 'ENOENT') throw error;
	}
}

/**
 * At startup, where the server owns the instance: a lock an earlier process left, with whatever its
 * extraction left, and any reclaim marker a contender died holding. Its process id may since have been
 * reused, so it is not consulted.
 */
export async function releaseStaleExtractionLock(): Promise<void> {
	const path = extractionLockPath();
	for (const name of listBaseDir(dirname(path))) {
		const marker = name.startsWith(EXTRACTION_LOCK_FILE + RECLAIM_MARKER_INFIX);
		// a temp names its creator's pid; this process's threads may be creating one now
		const strayTemp =
			name.startsWith(`${EXTRACTION_LOCK_FILE}.`) &&
			name.endsWith(TEMP_SUFFIX) &&
			!name.startsWith(`${EXTRACTION_LOCK_FILE}.${process.pid}-`);
		if (marker || strayTemp) rmSync(join(dirname(path), name), { force: true });
	}
	if (!existsSync(path)) return;
	const owner = readOwner(path);
	if (owner?.incarnation === processIncarnation) return;
	await removeAbandonedAreas(owner);
	rmSync(path, { force: true });
}

function listBaseDir(directory: string): string[] {
	try {
		return readdirSync(directory);
	} catch {
		return [];
	}
}

let watching = false;

/** Main thread only, once per process. */
export function watchExtractionLockOwners(onThreadExit: (listener: (threadId: number) => void) => void): void {
	if (watching) return;
	watching = true;
	onThreadExit((exitedThreadId) => {
		releaseExtractionOfExitedThread(exitedThreadId).catch((error) =>
			logger.error('Could not release the archive extraction of an exited thread', error)
		);
	});
}
