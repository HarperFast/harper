'use strict';

import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/** Codes that mean "this platform does not support flushing a directory", not "the write failed". */
const DIRECTORY_FSYNC_UNSUPPORTED = new Set(['EPERM', 'EISDIR', 'ENOTSUP', 'EINVAL']);

/**
 * fsync a directory so a create/unlink of an entry within it is durable. Best-effort: the flush is a
 * POSIX nicety, and Windows (and some filesystems) reject it — at the open on some, and at the fsync
 * on others, where opening a directory succeeds and only the flush fails. Both have to be tolerated,
 * or every durable write throws there.
 */
export function fsyncDirectory(directory: string): void {
	let directoryFd: number;
	try {
		directoryFd = openSync(directory, 'r');
	} catch (error: any) {
		if (DIRECTORY_FSYNC_UNSUPPORTED.has(error?.code)) return;
		throw error;
	}
	try {
		fsyncSync(directoryFd);
	} catch (error: any) {
		if (!DIRECTORY_FSYNC_UNSUPPORTED.has(error?.code)) throw error;
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
