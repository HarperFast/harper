'use strict';

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Per-backup completion manifest for RocksDB managed backups.
 *
 * `create_backup` is two-phase: the engine backup (`rootStore.backup()`) resolves — and becomes
 * visible to `list_backups`/`verify_backup`/`restore_backup` — before the blob snapshot is copied.
 * Without a completion record, a blob-snapshot failure (or a crash between the two phases) leaves an
 * engine backup on disk that lists and verifies as healthy while silently missing its blobs, and a
 * concurrent restore could select a backup id whose blob snapshot is still being written and treat
 * it as an intentional engine-only backup.
 *
 * A manifest at `<backupDir>/manifests/<backupId>.json` is written (atomically, temp + rename) only
 * after *both* phases are durably in place, and records whether blobs were captured. Consumers treat
 * a backup id with no manifest as incomplete — not usable for restore, and hidden from the listing.
 * The `manifests/` directory is Harper-managed and ignored by the rocksdb-js binding (same as the
 * sibling `blobs/` and `transaction_logs/` directories).
 */

const MANIFEST_DIR = 'manifests';

export type BackupManifest = {
	/** The RocksDB backup id this manifest completes. */
	backupId: number;
	/** Whether the backup captured the database's file-backed blobs (false = engine-only). */
	blobs: boolean;
	/** Epoch-ms timestamp when both phases completed. */
	completedAt: number;
};

function manifestDir(backupDir: string): string {
	return join(backupDir, MANIFEST_DIR);
}

function manifestPath(backupDir: string, backupId: number): string {
	return join(manifestDir(backupDir), `${backupId}.json`);
}

/**
 * Write a backup's completion manifest atomically. Call only after the engine backup and (when
 * included) the blob snapshot are both durable — its presence is what marks the backup usable.
 */
export async function writeBackupManifest(backupDir: string, backupId: number, blobs: boolean): Promise<void> {
	const dir = manifestDir(backupDir);
	await mkdir(dir, { recursive: true });
	const manifest: BackupManifest = { backupId, blobs, completedAt: Date.now() };
	const tempPath = join(dir, `.tmp-${backupId}.json`);
	await writeFile(tempPath, JSON.stringify(manifest));
	await rename(tempPath, manifestPath(backupDir, backupId)); // atomic publish
}

/** Read a backup's completion manifest, or null when it has none (incomplete / not yet written). */
export async function readBackupManifest(backupDir: string, backupId: number): Promise<BackupManifest | null> {
	try {
		return JSON.parse(await readFile(manifestPath(backupDir, backupId), 'utf8')) as BackupManifest;
	} catch (error: any) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}

/** Whether a backup id has a completion manifest (i.e. its creation finished). */
export function isBackupComplete(backupDir: string, backupId: number): boolean {
	return existsSync(manifestPath(backupDir, backupId));
}

/** Remove a backup's manifest (paired with deleting the backup); best-effort. */
export async function deleteBackupManifest(backupDir: string, backupId: number): Promise<void> {
	await rm(manifestPath(backupDir, backupId), { force: true });
}

/** Remove manifests for every backup id not in `keepIds` (paired with `backups.purge`). */
export async function purgeBackupManifests(backupDir: string, keepIds: Set<number>): Promise<void> {
	const dir = manifestDir(backupDir);
	if (!existsSync(dir)) return;
	for (const name of await readdir(dir)) {
		const match = /^(\d+)\.json$/.exec(name);
		if (match && !keepIds.has(Number(match[1]))) await rm(join(dir, name), { force: true });
	}
}

/**
 * Read every completion manifest in a backup directory, keyed by backup id. Backup ids without a
 * manifest (incomplete) are absent from the map. A manifest that fails to parse is skipped.
 */
export async function readAllManifests(backupDir: string): Promise<Map<number, BackupManifest>> {
	const dir = manifestDir(backupDir);
	const manifests = new Map<number, BackupManifest>();
	if (!existsSync(dir)) return manifests;
	for (const name of await readdir(dir)) {
		const match = /^(\d+)\.json$/.exec(name);
		if (!match) continue;
		const backupId = Number(match[1]);
		const manifest = await readBackupManifest(backupDir, backupId).catch(() => null);
		if (manifest) manifests.set(backupId, manifest);
	}
	return manifests;
}
