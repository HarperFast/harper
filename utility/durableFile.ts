'use strict';

import { closeSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fsyncTolerantSync, isUnsupportedSyncError } from './fsync.ts';

/**
 * Durable, atomic single-file writes for the small pieces of control-plane state Harper keeps on
 * disk beside a database or a backup repository — restore markers, restore intent, backup pins.
 *
 * Two properties matter for all of them, and neither comes from `writeFileSync`:
 *
 * - **A torn write must never replace a valid file.** The content is written to a temp sibling and
 *   renamed over the target, so the target only ever holds the previous content or the complete new
 *   content.
 * - **The result must survive a power loss**, because the state is read on the next boot to decide
 *   whether a database is safe to load. That needs an fsync of the file *and* of the directory that
 *   now names it.
 */

/**
 * Whether `path` is there, where only an established absence answers false. `existsSync` reports
 * every errno as "missing", and the control-plane state this module writes is read to decide
 * whether something may be destroyed — so a permission or I/O fault that reads as "absent" becomes
 * permission to delete exactly what could not be checked.
 */
export function pathPresent(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch (error: any) {
		if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
		throw error;
	}
}

/**
 * fsync a directory so a create/unlink of an entry within it is durable. Best-effort: Windows and
 * some filesystems reject it — at the open on some, at the fsync on others — and both have to be
 * tolerated or every durable write throws there. The codes that mean "unsupported" rather than
 * "failed" live in `./fsync.ts`, so this cannot drift from the other callers making that same
 * distinction; `restoreMarker.ts` used that set before this helper existed.
 */
export function fsyncDirectory(directory: string): void {
	let directoryFd: number;
	try {
		directoryFd = openSync(directory, 'r');
	} catch (error: any) {
		if (isUnsupportedSyncError(error)) return;
		throw error;
	}
	try {
		fsyncTolerantSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
}

/**
 * Write `contents` to `path` atomically and durably. `tempName` must be a name no reader of the
 * directory will mistake for real state, and callers holding a lock on the target may reuse a fixed
 * one — a temp left by an earlier crash is then their own debris and is simply overwritten.
 */
export function writeFileDurably(path: string, contents: string, tempName: string): void {
	const directory = dirname(path);
	const tempPath = join(directory, tempName);
	try {
		const fd = openSync(tempPath, 'w');
		try {
			writeSync(fd, contents);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tempPath, path);
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch {
			// debris either way; the write failure is the error worth reporting
		}
		throw error;
	}
	fsyncDirectory(directory);
}

/** Remove a file and make its removal durable. Missing is success — the goal is that it is gone. */
export function removeFileDurably(path: string): void {
	try {
		unlinkSync(path);
	} catch (error: any) {
		if (error.code === 'ENOENT') return;
		throw error;
	}
	fsyncDirectory(dirname(path));
}
