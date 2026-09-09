'use strict';

import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { ClientError } from '../utility/errors/hdbError.ts';
import logger from '../utility/logging/harper_logger.ts';
import {
	type BlobCaptureDisposition,
	classifyBlobFileForCapture,
	createCaptureMarker,
	isSystemicIoError,
} from '../resources/blob.ts';

/**
 * Managed-backup snapshotting of a database's file-backed blobs.
 *
 * A database's blobs live in one or more root directories *outside* the RocksDB directory (see
 * `resources/blob.ts` `getBlobPathsForDatabaseName`), so the engine's own backup does not capture
 * them. These helpers snapshot the blob roots alongside a RocksDB managed backup and restore them
 * with it, so a restored database's records still resolve their file-backed blobs.
 *
 * Layout mirrors the binding's transaction-log snapshots (`<backupDir>/transaction_logs/<id>/`): a
 * full, non-incremental copy per backup at `<backupDir>/blobs/<backupId>/<rootIndex>/<relpath>`,
 * where `rootIndex` is the position of the source root in the database's blob-root list (preserved
 * so a multi-root database restores each root back to its original slot). Files are hard-linked when
 * possible (cheap, no extra space on the same filesystem) and copied otherwise (never symlinked, so
 * a snapshot is a standalone set of files that survives independent of the live blob).
 *
 * Harper does not freeze blob writes for a backup, and a blob is written in place at its final path,
 * so the walk can meet one that is still growing. Hard-linking that inode would put bytes in the
 * snapshot that keep changing after it was taken. Every entry returned by the walk is therefore
 * classified (`captureBlobFile`): a complete blob is linked, and one that becomes unavailable or is
 * not yet complete is replaced by a marker rather than dropped. This closes the classify-to-capture
 * race and keeps that file id reserved; a file reclaimed before its parent directory is read remains
 * outside the snapshot.
 *
 * Past that gate, hard-linking is safe against later mutation: each write takes a fresh monotonic
 * file id, and an update, delete, or in-place repair replaces or unlinks the path rather than
 * rewriting the inode.
 */

/** Directory holding all blob snapshots for a backup repository. */
export function blobsRootDir(backupDir: string): string {
	return join(backupDir, 'blobs');
}

/** Directory holding a single backup id's blob snapshot. */
export function blobSnapshotDir(backupDir: string, backupId: number): string {
	return join(blobsRootDir(backupDir), String(backupId));
}

/**
 * Hard-link `src` to `dest`, falling back to a copy when the two are on different filesystems (or
 * the filesystem does not support additional hard links). Never creates a symlink. Returns false
 * when the source vanishes so the caller can substitute a marker for it. `counts.copied` is what a
 * caller on a latency budget needs: the fallback turns a constant-time clone into an O(bytes) one.
 */
async function linkOrCopy(src: string, dest: string, counts?: { copied: number }): Promise<boolean> {
	await mkdir(dirname(dest), { recursive: true });
	try {
		await link(src, dest);
	} catch (error: any) {
		if (error.code === 'ENOENT') {
			if (!existsSync(src)) return false; // vanished since it was classified
			throw error;
		}
		if (
			error.code === 'EXDEV' || // cross-device link
			error.code === 'EMLINK' || // link count exhausted
			error.code === 'EPERM' || // filesystem forbids hard links
			error.code === 'ENOTSUP' ||
			error.code === 'EOPNOTSUPP'
		) {
			try {
				await copyFile(src, dest);
			} catch (copyError: any) {
				if (copyError.code === 'ENOENT') return false;
				throw copyError;
			}
			if (counts) counts.copied++;
			return true;
		}
		if (error.code === 'EEXIST') {
			await unlink(dest);
			return linkOrCopy(src, dest, counts);
		}
		throw error;
	}
	return true;
}

/** What a substituted marker says happened, so a branch clone doesn't report itself as a backup. */
export interface CaptureMarkerReasons {
	gone: string;
	pending: string;
}

const BACKUP_MARKER_REASONS: CaptureMarkerReasons = {
	gone: 'blob was deleted while this backup was being taken',
	pending: 'blob was not yet complete when this backup was taken',
};

/** Put one blob file into the destination, returning how the entry was captured. */
async function captureBlobFile(
	srcPath: string,
	destPath: string,
	reasons: CaptureMarkerReasons = BACKUP_MARKER_REASONS,
	counts?: { copied: number }
): Promise<BlobCaptureDisposition> {
	let disposition: BlobCaptureDisposition;
	try {
		disposition = await classifyBlobFileForCapture(srcPath);
	} catch (error) {
		// This rethrow is unverified: only the membership of SYSTEMIC_IO_ERRORS is tested, because
		// reaching it needs a real host-level fault no test here can produce.
		if (isSystemicIoError(error)) throw error;
		// Fall back to what this walk did before it classified anything. `link()` needs no read permission
		// on the source, so a blob this failed to *read* may still be perfectly capturable; substituting
		// here would turn an unreadable-but-valid root into a backup of nothing but stubs.
		logger.warn(`Could not verify blob ${srcPath} for snapshot; capturing it unverified`, error);
		disposition = 'capture';
	}
	if (disposition === 'skip') return disposition;
	if (disposition === 'capture') {
		if (await linkOrCopy(srcPath, destPath, counts)) return disposition;
		disposition = 'gone';
	}
	await mkdir(dirname(destPath), { recursive: true });
	await writeFile(destPath, createCaptureMarker(disposition, disposition === 'gone' ? reasons.gone : reasons.pending));
	return disposition;
}

/**
 * Recursively copy every file under `srcRoot` into `destRoot` (hard-link-else-copy), preserving the
 * relative directory structure. Missing `srcRoot` is a no-op (a database with no blobs yet).
 *
 * `classify` substitutes a marker for a file that is mid-write or already gone, so the destination
 * fails loudly on that blob rather than carrying a truncated one. It belongs to the capture direction
 * only; restore must replace exactly what the snapshot holds.
 *
 * Also used by branch materialization (harper#644), which clones a base's blob roots into the
 * branch's own so the OS inode refcount does the reference counting. Its walk runs inside a window
 * other threads wait on, which is what `onProgress` is for.
 */
export async function copyTree(
	srcRoot: string,
	destRoot: string,
	classify = false,
	reasons?: CaptureMarkerReasons,
	onProgress?: () => void
): Promise<{ substituted: number; captured: number; copied: number }> {
	const counts = { substituted: 0, captured: 0, copied: 0 };
	if (!existsSync(srcRoot)) return counts;
	const stack: string[] = [srcRoot];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error: any) {
			if (error.code === 'ENOENT') continue; // directory removed mid-walk
			throw error;
		}
		for (const entry of entries) {
			const srcPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(srcPath);
			} else if (entry.isFile()) {
				const destPath = join(destRoot, relative(srcRoot, srcPath));
				if (classify) {
					const disposition = await captureBlobFile(srcPath, destPath, reasons, counts);
					if (disposition === 'pending' || disposition === 'gone') counts.substituted++;
					else if (disposition === 'capture') counts.captured++;
				} else {
					await linkOrCopy(srcPath, destPath, counts);
				}
				onProgress?.();
			}
			// symlinks/other node types in a blob root are not expected and are intentionally skipped
		}
	}
	return counts;
}

/**
 * Copy every blob root into `destDir` as `<rootIndex>/<relpath>`, hard-linking where possible.
 * Writes to a temporary sibling and atomically renames into place so a run that fails mid-copy never
 * leaves a partial directory a later restore would trust, and replaces any pre-existing `destDir`.
 * Shared by managed-backup snapshots and `copy-db`'s standalone blob copy (harper#2048).
 */
export async function copyBlobRootsByIndex(destDir: string, blobRoots: string[]): Promise<void> {
	const tempDir = destDir + '.tmp';
	await rm(tempDir, { recursive: true, force: true });
	await mkdir(tempDir, { recursive: true });
	try {
		let substituted = 0;
		let captured = 0;
		for (let index = 0; index < blobRoots.length; index++) {
			const counts = await copyTree(blobRoots[index], join(tempDir, String(index)), true);
			substituted += counts.substituted;
			captured += counts.captured;
		}
		if (substituted > 0) {
			logger.warn(
				`Blob copy into ${destDir} substituted ${substituted} of ${substituted + captured} blob ` +
					`file(s) with PENDING or ERROR markers because they were not capturable whole.`
			);
		}
		await rm(destDir, { recursive: true, force: true });
		await rename(tempDir, destDir);
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Snapshot a database's blob roots into a backup's blob directory. Overwrites any pre-existing
 * snapshot for the same id (create_backup always produces a fresh id, so this only matters on a
 * retried offline run).
 */
export async function snapshotBlobs(backupDir: string, backupId: number, blobRoots: string[]): Promise<void> {
	await copyBlobRootsByIndex(blobSnapshotDir(backupDir, backupId), blobRoots);
	await writeBlobsReadme(backupDir, blobRoots);
}

/**
 * Build the `blobs/README.md` documenting the blob snapshot layout, so an operator inspecting or
 * hand-recovering a backup can decode the numeric directories. Three variants:
 * - `managed` (default): a create_backup repository, where snapshots are keyed by backup id
 *   (`<backupId>/<rootIndex>/…`) and restore is automatic via `restore_backup`.
 * - `archive`: a downloaded `get_backup` tar, which holds a single snapshot with no backup-id level
 *   (`<rootIndex>/…`) and is restored by extracting the files back into the roots.
 * - `copy`: the companion directory `copy-db` writes beside a database copy, restored by hand.
 */
export function blobsReadmeContent(
	blobRoots: string[],
	{ variant = 'managed' }: { variant?: 'managed' | 'archive' | 'copy' } = {}
): string {
	const rootMapping =
		blobRoots.length > 0 ? blobRoots.map((root, index) => `      ${index} -> ${root}`).join('\n') : '      (none)';
	const layout =
		variant === 'managed'
			? '<backupId>/<rootIndex>/<shard1>/<shard2>/<fileId>'
			: '<rootIndex>/<shard1>/<shard2>/<fileId>';
	const intro =
		variant === 'copy'
			? `This directory holds the file-backed blobs of a \`copy-db\` database copy; the database file itself
is the sibling \`.mdb\` this directory is named after. Blobs are addressed by database NAME and the
configured blob roots — never by the database file's path — so a copy is only restorable with these
files: put each \`<rootIndex>/\` tree into the matching blob root of whatever database name you
restore the copy as (mapping below).`
			: variant === 'archive'
				? `This directory holds this database's file-backed blobs within a downloaded \`get_backup\` archive.
To restore them, extract each \`<rootIndex>/\` tree back into the matching blob root (see the mapping
below and ../README.md).`
				: `This directory holds point-in-time snapshots of this database's file-backed blobs, captured
alongside each RocksDB managed backup. You do not restore these by hand — \`restore_backup\` puts
them back automatically (see ../README.md); this file just documents the layout.`;
	const backupIdBullet =
		variant === 'managed'
			? `- **<backupId>** matches the RocksDB backup id (\`harper list_backups\`). Each id is a full,
  independent snapshot (not incremental).
`
			: '';
	return `# Harper blob snapshots

${intro}

## Directory layout

    ${layout}

${backupIdBullet}- **<rootIndex>** is which of the database's blob roots the file came from — the index into
  \`storage.blobPaths[n]\`. When \`storage.blobPaths\` is not configured there is a single default root
  (\`<rootPath>/blobs/<db>\`) at index 0. Current mapping:

${rootMapping}

- **<shard1>/<shard2>/<fileId>** is Harper's on-disk blob layout, copied verbatim from the live
  root: the hex blob file id split into two directory levels plus the file itself (keeping roughly
  4096 entries per directory). E.g. a blob with id \`0x12345678\` lives at \`12/345/678\`; a short id
  like \`0xc1a\` lives at \`0/0/c1a\`.

Complete blobs are hard links to the live blobs when the destination is on the same filesystem, and
copies otherwise. A blob that was not capturable whole is stored as a marker instead: header type
\`0xfe\` is retryable (PENDING), while \`0xff\` is terminal (ERROR). The marker preserves the file id
but does not contain the original blob bytes.
`;
}

/**
 * Write the `blobs/README.md` into a managed backup's `blobs/` directory. Best-effort: a failure to
 * write the doc must not fail an otherwise-successful backup.
 */
export async function writeBlobsReadme(backupDir: string, blobRoots: string[]): Promise<void> {
	try {
		await writeFile(join(blobsRootDir(backupDir), 'README.md'), blobsReadmeContent(blobRoots));
	} catch (error) {
		logger.warn(`Failed to write blob snapshot README in ${backupDir}: ${(error as Error).message}`);
	}
}

/** The blob-root indices present in a snapshot (sorted); [] when the backup has no blob snapshot. */
async function snapshotRootIndices(snapshotDir: string): Promise<number[]> {
	if (!existsSync(snapshotDir)) return [];
	return (await readdir(snapshotDir, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
		.map((entry) => Number(entry.name))
		.sort((a, b) => a - b);
}

/**
 * Reject (before any destructive step) a restore whose snapshot has more blob roots than the
 * database is currently configured with. File-backed blob references persist their `storageIndex`,
 * so a record written under root index 1 keeps resolving through `blobRoots[1]`; collapsing the
 * out-of-range index onto another root would preserve the bytes at the wrong address and the restore
 * would "succeed" while reads of those blobs fail. The operator must reconcile `storage.blobPaths`
 * to at least as many roots as the backup before restoring. Callers invoke this ahead of the engine
 * restore so a mismatch never purges the database.
 */
export async function assertBlobSnapshotRestorable(
	backupDir: string,
	backupId: number,
	blobRoots: string[]
): Promise<void> {
	const indices = await snapshotRootIndices(blobSnapshotDir(backupDir, backupId));
	const maxIndex = indices.length > 0 ? indices[indices.length - 1] : -1;
	if (maxIndex >= blobRoots.length) {
		throw new ClientError(
			`Cannot restore backup ${backupId}: it captured ${maxIndex + 1} blob root(s) but the database is now configured with ${blobRoots.length}. ` +
				`Blob references persist their root index, so restoring would mis-address blobs — set 'storage.blobPaths' to at least ${maxIndex + 1} root(s) before restoring.`
		);
	}
}

/**
 * Restore a backup's blob snapshot back into the database's blob roots. Each root is purged and
 * rewritten from `blobs/<backupId>/<rootIndex>/` so the restored blob set matches the backup exactly
 * (a newer blob written after the backup is removed, mirroring the engine's `purgeAllFiles` restore).
 *
 * A backup created with blobs excluded (or an older backup that predates blob snapshots) has no
 * snapshot directory: in that case the live blob roots are left untouched and a warning is logged,
 * since purging them would strip blobs the restored records may still reference. Roots are restored
 * by index into the *same* configured root; an incompatible root count is rejected up front (see
 * `assertBlobSnapshotRestorable`) rather than collapsed, so blobs are never mis-addressed.
 */
export async function restoreBlobSnapshot(
	backupDir: string,
	backupId: number,
	databaseName: string,
	blobRoots: string[]
): Promise<void> {
	const snapshotDir = blobSnapshotDir(backupDir, backupId);
	if (!existsSync(snapshotDir)) {
		logger.warn(
			`Backup ${backupId} of database '${databaseName}' has no blob snapshot; leaving existing blob files in place (this backup did not include blobs)`
		);
		return;
	}
	// defense in depth: the restore flow pre-checks before the engine restore, but re-validate here
	// so this function never mis-addresses blobs regardless of caller
	await assertBlobSnapshotRestorable(backupDir, backupId, blobRoots);
	const indexDirs = await snapshotRootIndices(snapshotDir);
	// purge every current blob root first so nothing newer than the backup survives the restore
	for (const root of blobRoots) {
		await rm(root, { recursive: true, force: true });
	}
	for (const index of indexDirs) {
		await copyTree(join(snapshotDir, String(index)), blobRoots[index]);
	}
}

/**
 * Remove the blob snapshot for a single backup id (paired with `backups.delete`). Best-effort:
 * a missing snapshot directory is fine.
 */
export async function deleteBlobSnapshot(backupDir: string, backupId: number): Promise<void> {
	await rm(blobSnapshotDir(backupDir, backupId), { recursive: true, force: true });
}

/**
 * Remove blob snapshots for every backup id not in `keepIds` (paired with `backups.purge`, which
 * reference-counts and removes the engine files; blob snapshots are full per-id copies, so they are
 * simply deleted). Given the ids that survive the purge, this deletes the rest.
 */
export async function purgeBlobSnapshots(backupDir: string, keepIds: Set<number>): Promise<void> {
	const root = blobsRootDir(backupDir);
	if (!existsSync(root)) return;
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		if (keepIds.has(Number(entry.name))) continue;
		await rm(join(root, entry.name), { recursive: true, force: true });
	}
}
