'use strict';

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileLockRelease, tryFileLock } from '@harperfast/rocksdb-js';
import { ClientError } from '../utility/errors/hdbError.ts';
import { removeFileDurably, writeFileDurably } from '../utility/durableFile.ts';

/**
 * Harper-level coordination for a backup repository: one exclusive management lock, and pins that
 * keep a backup alive while something is depending on it.
 *
 * rocksdb-js has its own `.backup.lock`, but it only covers the engine files. Harper's blob
 * snapshots and completion manifests live beside them and are written and removed by separate
 * Harper code, so a `purge_backups` can still remove a blob snapshot out from under a
 * `create_backup` that is mid-finalization, or out from under a restore that is reading it
 * (harper#2031). Everything that mutates the *Harper-managed* parts of a repository therefore takes
 * this lock, in this order: management lock first, then any engine call that takes `.backup.lock`.
 *
 * A pin is the other half. A restore selects a backup and then acts on it — across a restart, in the
 * case of a deferred restore — and a delete or purge in between would leave it with no source. Pins
 * are installed and checked under the same lock, so "is this id pinned?" cannot be answered stale:
 * without that, a delete could read "unpinned", pause, and resume after a pin landed.
 */

const MANAGEMENT_LOCK_FILE = '.management.lock';
const PINS_DIR = 'pins';
const PIN_FILE_SUFFIX = '.json';
/** Filesystem-safe, and short enough to stay well inside NAME_MAX once suffixed. */
const PIN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const LOCK_POLL_INTERVAL_MS = 50;
const LOCK_WAIT_TIMEOUT_MS = 30_000;

export function managementLockPath(backupDir: string): string {
	return join(backupDir, MANAGEMENT_LOCK_FILE);
}

export function backupPinsDir(backupDir: string): string {
	return join(backupDir, PINS_DIR);
}

export interface BackupPin {
	pin_id: string;
	backup_id: number;
	reason: string;
	created_at: number;
}

/**
 * Run `operation` holding the repository's management lock.
 *
 * Waits rather than failing immediately: the operations it serializes are short (a manifest write,
 * a snapshot removal) except for a blob snapshot of a large database, and a `delete_backup` that
 * 409s because an unrelated `create_backup` was finalizing is a worse answer than a brief wait. A
 * holder that dies releases the lock with its process, so the wait cannot outlive a crash.
 */
export async function withBackupRepositoryLock<T>(
	backupDir: string,
	databaseName: string,
	operation: () => Promise<T>
): Promise<T> {
	mkdirSync(backupDir, { recursive: true });
	const lockPath = managementLockPath(backupDir);
	const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
	let token = tryFileLock(lockPath);
	while (token === 0) {
		if (Date.now() >= deadline) {
			throw new ClientError(
				`Another backup management operation is in progress for database '${databaseName}'; retry once it finishes`,
				409
			);
		}
		await delay(LOCK_POLL_INTERVAL_MS);
		token = tryFileLock(lockPath);
	}
	try {
		return await operation();
	} finally {
		fileLockRelease(token);
	}
}

function pinPath(backupDir: string, pinId: string): string {
	if (!PIN_ID_PATTERN.test(pinId)) throw new ClientError(`Invalid backup pin id '${pinId}'`);
	return join(backupPinsDir(backupDir), pinId + PIN_FILE_SUFFIX);
}

/** Every pin currently held on a repository. A malformed pin file is reported, never silently ignored. */
export function readBackupPins(backupDir: string): BackupPin[] {
	const pinsDir = backupPinsDir(backupDir);
	if (!existsSync(pinsDir)) return [];
	const pins: BackupPin[] = [];
	for (const entry of readdirSync(pinsDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(PIN_FILE_SUFFIX)) continue;
		const pinId = entry.name.slice(0, -PIN_FILE_SUFFIX.length);
		let parsed: any;
		try {
			parsed = JSON.parse(readFileSync(join(pinsDir, entry.name), 'utf8'));
		} catch {
			// A pin that cannot be read still means something claimed a backup. Fail closed by reporting
			// it against every id: a torn pin file must not become permission to delete the source.
			pins.push({ pin_id: pinId, backup_id: Number.NaN, reason: 'unreadable pin', created_at: 0 });
			continue;
		}
		pins.push({
			pin_id: pinId,
			backup_id: parsed.backup_id,
			reason: typeof parsed.reason === 'string' ? parsed.reason : 'unspecified',
			created_at: parsed.created_at ?? 0,
		});
	}
	return pins;
}

/**
 * Claim a backup so it cannot be deleted or purged. The caller must hold the management lock, which
 * is what makes the claim atomic with the delete/purge admission check.
 */
export function pinBackup(backupDir: string, pinId: string, backupId: number, reason: string): void {
	const path = pinPath(backupDir, pinId);
	mkdirSync(backupPinsDir(backupDir), { recursive: true });
	const pin: BackupPin = { pin_id: pinId, backup_id: backupId, reason, created_at: Date.now() };
	writeFileDurably(path, JSON.stringify(pin), `${pinId}.tmp`);
}

/** Release a claim. Missing is success — the goal is that nothing holds this backup any more. */
export function unpinBackup(backupDir: string, pinId: string): void {
	removeFileDurably(pinPath(backupDir, pinId));
}

/**
 * Refuse to remove any of `backupIds` while something holds a pin on it. An unreadable pin blocks
 * every id: what it was protecting is exactly what cannot be determined.
 */
export function assertBackupsUnpinned(backupDir: string, backupIds: number[], databaseName: string): void {
	const pins = readBackupPins(backupDir);
	if (pins.length === 0) return;
	const requested = new Set(backupIds);
	const blocking = pins.filter((pin) => Number.isNaN(pin.backup_id) || requested.has(pin.backup_id));
	if (blocking.length === 0) return;
	const described = blocking
		.map((pin) => `${Number.isNaN(pin.backup_id) ? 'unknown backup' : `backup ${pin.backup_id}`} (${pin.reason})`)
		.join(', ');
	throw new ClientError(
		`Cannot remove backups of database '${databaseName}' that are in use: ${described}. ` +
			`Finish or cancel the operation holding them first.`,
		409
	);
}
