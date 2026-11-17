/**
 * `restore_backup` from a `get_backup` archive. The upload is extracted as it arrives, beside each
 * destination, proven where it sits while the target still serves, and installed by rename through the
 * restore publication protocol. See dataLayer/DESIGN.md.
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { ClientError } from '../utility/errors/hdbError.ts';
import logger from '../utility/logging/harper_logger.ts';
import { OPERATIONS_ENUM } from '../utility/hdbTerms.ts';
import { getDatabases, resolveDatabasePath } from '../resources/databases.ts';
import { getBlobPathsForDatabaseName } from '../resources/blob.ts';
import { assertNoReplicationPeers } from '../server/replicationMembership.ts';
import { extractArchiveStream } from './archiveExtraction.ts';
import { acquireExtractionLock } from './archiveExtractionLock.ts';
import {
	archiveRouter,
	assertUploadFits,
	createStagingAreas,
	mintStagingId,
	planStaging,
	readStagedRecord,
	removeStagingArea,
	stagedAreas,
	stagingBudgets,
	stagingDirFor,
	withIdentities,
	writeStagedRecord,
	type StagedRecord,
} from './archiveStaging.ts';
import type { BackupArchiveManifest } from './backupArchiveManifest.ts';
import { readRestoreReceipt, isStagedReceipt } from './restoreReceipt.ts';
import { runRestoreChild } from './restoreChildRunner.ts';
import { interruptedArchiveRestore, publishRestore, type StagedRestoreSource } from './restorePublication.ts';
import {
	backupDirForDatabase,
	readRestoreRequest,
	requireRocksRootStore,
	requireSuperUser,
	validateDatabaseName,
} from './rocksdbBackup.ts';

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
// an archive names no source database, and resume/cancel act on a record, not an upload
const NOT_WITH_AN_ARCHIVE: Record<string, string> = {
	backup_id: `'backup_id' names a managed backup; omit it when restoring an archive`,
	immutable_source: `'immutable_source' applies to a backup repository, not an archive`,
	target_database: `an archive restores into 'database', which may be a new database; omit 'target_database'`,
	allow_engine_only: `an archive restore replaces the blob roots with what the archive carries; omit 'allow_engine_only'`,
	resume: `'resume' finishes an interrupted restore from its record; send it without an archive`,
	cancel: `'cancel' withdraws a restore by its record; send it without an archive`,
	staging_id: `'staging_id' is set by the server`,
};

export interface ArchiveRestoreOptions {
	databaseName: string;
	onRestart: boolean;
	retainPrevious: boolean;
	acceptIncompatible: boolean;
	acceptUnverifiedBlobs: boolean;
	sha256?: string;
}

function readArchiveRestoreOptions(request: any, { offline = false } = {}): ArchiveRestoreOptions {
	for (const [field, message] of Object.entries(NOT_WITH_AN_ARCHIVE)) {
		if (request[field] !== undefined) throw new ClientError(message);
	}
	const { databaseName, onRestart, retainPrevious, acceptIncompatible, acceptUnverifiedBlobs } = readRestoreRequest(
		request,
		{ offline }
	);
	if (request.sha256 !== undefined && (typeof request.sha256 !== 'string' || !SHA256_PATTERN.test(request.sha256))) {
		throw new ClientError(`'sha256' must be 64 hexadecimal characters`);
	}
	return {
		databaseName,
		onRestart,
		retainPrevious,
		acceptIncompatible,
		acceptUnverifiedBlobs,
		sha256: request.sha256?.toLowerCase(),
	};
}

/** The legacy layout: a directory of per-table LMDB files. */
function holdsLmdbTables(databaseDir: string): boolean {
	try {
		return readdirSync(databaseDir, { withFileTypes: true }).some(
			(entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.mdb'
		);
	} catch {
		return false;
	}
}

/** The target, refused if it is LMDB: `get_backup` of an LMDB database is a database file, not this archive. */
function archiveTarget(databaseName: string, { offline = false } = {}): { databaseDir: string; blobRoots: string[] } {
	validateDatabaseName(databaseName);
	const loaded = offline ? undefined : getDatabases()[databaseName];
	const databaseDir =
		loaded != null && Object.keys(loaded).length > 0
			? requireRocksRootStore(databaseName, OPERATIONS_ENUM.RESTORE_BACKUP).path
			: resolveDatabasePath(databaseName);
	if (
		existsSync(`${databaseDir}.mdb`) ||
		(existsSync(databaseDir) && !statSync(databaseDir).isDirectory()) ||
		holdsLmdbTables(databaseDir)
	) {
		throw new ClientError(
			`Database '${databaseName}' uses the LMDB storage engine; restoring a get_backup archive requires a RocksDB database`
		);
	}
	return { databaseDir, blobRoots: getBlobPathsForDatabaseName(databaseName) };
}

/** Before an upload is read: an interrupted archive restore owns the target until it is resumed or cancelled. */
function assertTargetAdmitsArchive(databaseName: string, databaseDir: string): void {
	const read = readRestoreReceipt(databaseDir);
	if (read.kind === 'unreadable') {
		throw new ClientError(
			`Database '${databaseName}' has a restore record that cannot be read (${read.reason}); remove it with restore_backup cancel=true first`,
			409
		);
	}
	if (read.kind !== 'valid') return;
	const earlier = read.receipt;
	if (earlier.state === 'committed') {
		throw new ClientError(`Database '${databaseName}' is finishing an earlier restore; retry shortly`, 409);
	}
	if (isStagedReceipt(earlier) && earlier.state !== 'terminal') throw interruptedArchiveRestore(databaseName, earlier);
}

export interface StagedArchive {
	stagingDir: string;
	record: StagedRecord;
}

/**
 * Extracts `input` into a fresh staging area beside each destination, one extraction at a time per
 * instance, and writes its `staged.json` last. On any failure the area is removed before the extraction
 * lock is released, and before the error propagates unless `removeInBackground`, which a client waiting
 * on the refusal needs; the stream is consumed or destroyed either way. A function is called to open the
 * stream only once the upload is admitted.
 */
export async function stageArchive(
	input: Readable | (() => Readable),
	target: {
		databaseName: string;
		databaseDir: string;
		blobRoots: string[];
		acceptIncompatible: boolean;
		sha256?: string;
		restoredFrom: string;
		contentLength?: number;
		removeInBackground?: boolean;
	}
): Promise<StagedArchive> {
	const plan = planStaging(target.databaseDir, target.blobRoots, mintStagingId());
	let stream = typeof input === 'function' ? undefined : input;
	let release: () => void;
	try {
		release = await acquireExtractionLock(plan.stagingId, plan.areas);
	} catch (error) {
		stream?.destroy();
		throw error;
	}
	let releaseAfterRemoval = false;
	try {
		let manifest: BackupArchiveManifest | null = null;
		let waived: string[] = [];
		try {
			createStagingAreas(plan);
			const budgets = await stagingBudgets(plan);
			assertUploadFits(plan, budgets, target.contentLength);
			stream ??= (input as () => Readable)();
			const extracted = await extractArchiveStream(stream, {
				router: archiveRouter(plan, {
					acceptIncompatible: target.acceptIncompatible,
					onManifest(found, foundWaived) {
						manifest = found;
						waived = foundWaived;
					},
				}),
				budgets,
				allowMissingManifest: target.acceptIncompatible,
			});
			if (target.sha256 && extracted.sha256 !== target.sha256) {
				throw new ClientError(
					`The archive's sha256 is ${extracted.sha256}, not the ${target.sha256} the request pinned`
				);
			}
			if (!existsSync(join(plan.parts[0].staged, 'CURRENT'))) {
				throw new ClientError('The archive holds no Harper database (it has no RocksDB CURRENT file)');
			}
			const record: StagedRecord = {
				version: 1,
				staging_id: plan.stagingId,
				database: target.databaseName,
				state: 'extracted',
				restored_from: target.restoredFrom,
				archive: {
					sha256: extracted.sha256,
					bytes: extracted.archiveBytes,
					inflated_bytes: extracted.inflatedBytes,
					entries: extracted.entries,
					files: extracted.files,
					payload_bytes: extracted.bytes,
				},
				manifest,
				waived,
				parts: withIdentities(plan.parts),
				created_at: Date.now(),
			};
			writeStagedRecord(plan.stagingDir, record);
			return { stagingDir: plan.stagingDir, record };
		} catch (error) {
			if (stream && !stream.destroyed) stream.destroy();
			const removal = removeStagingArea(plan.areas);
			if (!target.removeInBackground) await removal;
			else {
				releaseAfterRemoval = true;
				removal
					.then(release)
					.catch((releaseError) => logger.warn('Could not release the archive extraction lock', releaseError));
			}
			throw error;
		}
	} finally {
		if (!releaseAfterRemoval) release();
	}
}

function isReadable(value: unknown): value is Readable {
	return typeof (value as Readable)?.pipe === 'function' && typeof (value as Readable)?.on === 'function';
}

/** Queues the job with a staging id the server minted, never one a client sent. */
export async function restoreBackupFromUpload(
	request: any,
	executeJob: (json: any) => Promise<{ message: string; job_id: string }>
): Promise<Record<string, unknown>> {
	requireSuperUser(request, OPERATIONS_ENUM.RESTORE_BACKUP);
	const { payload, ...rest } = request;
	if (!isReadable(payload)) {
		throw new ClientError(`'payload' must be the archive as a multipart upload; from the CLI, pass file=<path>`);
	}
	const options = readArchiveRestoreOptions(rest);
	const { databaseDir, blobRoots } = archiveTarget(options.databaseName);
	// the authoritative check runs under the membership fence; this one saves reading an upload that would be refused
	assertNoReplicationPeers(options.databaseName);
	assertTargetAdmitsArchive(options.databaseName, databaseDir);
	const contentLength = Number((payload as any).requestContentLength);
	const { stagingDir, record } = await stageArchive(payload, {
		databaseName: options.databaseName,
		databaseDir,
		blobRoots,
		acceptIncompatible: options.acceptIncompatible,
		sha256: options.sha256,
		restoredFrom: 'upload',
		contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined,
		removeInBackground: true,
	});
	try {
		const queued = await executeJob({ ...rest, staging_id: basename(stagingDir) });
		return { ...queued, archive_sha256: record.archive.sha256 };
	} catch (error) {
		await removeStagingArea(stagedAreas(record));
		throw error;
	}
}

export function assertStagedArchiveQueued(databaseName: string, databaseDir: string, stagingId: unknown): void {
	readStagedRecord(stagingDirFor(databaseDir, stagingId as string), databaseName);
}

function receiptOwnsStaging(databaseDir: string, stagingDir: string): boolean {
	const read = readRestoreReceipt(databaseDir);
	// an unreadable record may name it, and recovery keeps such a database blocked rather than guess
	return read.kind === 'unreadable' || (read.kind === 'valid' && read.receipt.staging_dir === stagingDir);
}

/**
 * Runs the staged proof if it has not run, then hands the proven archive to `publish`. A failure
 * before a receipt names the area removes it; once one does, the receipt owns it.
 */
export async function restoreStagedArchive<T>(
	target: { databaseName: string; databaseDir: string; stagingId: string; acceptUnverifiedBlobs: boolean },
	publish: (staged: StagedRestoreSource) => Promise<T>
): Promise<T> {
	const stagingDir = stagingDirFor(target.databaseDir, target.stagingId);
	let record: StagedRecord | undefined;
	try {
		record = readStagedRecord(stagingDir, target.databaseName);
		if (record.state !== 'proven') {
			await runRestoreChild('prove-staged', {
				stagingDir,
				databaseName: target.databaseName,
				acceptUnverifiedBlobs: target.acceptUnverifiedBlobs,
			});
		}
		return await publish({
			stagingDir,
			restoredFrom: record.restored_from,
			archiveSha256: record.archive.sha256,
			sourceDatabase: record.manifest?.database,
		});
	} catch (error) {
		if (!receiptOwnsStaging(target.databaseDir, stagingDir)) {
			await removeStagingArea(
				record
					? stagedAreas(record)
					: planStaging(target.databaseDir, getBlobPathsForDatabaseName(target.databaseName), target.stagingId).areas
			);
		}
		throw error;
	}
}

export async function restoreArchiveOffline(request: any, file: string) {
	const options = readArchiveRestoreOptions(request, { offline: true });
	if (options.onRestart || request.retain_previous !== undefined) {
		throw new ClientError(`'on_restart' needs the server running; with Harper stopped the archive is restored now`);
	}
	const { databaseName } = options;
	const { databaseDir, blobRoots } = archiveTarget(databaseName, { offline: true });
	assertTargetAdmitsArchive(databaseName, databaseDir);
	const unreadable = (error: any) =>
		Object.assign(new ClientError(`Cannot read the archive '${file}': ${error?.code ?? error?.message}`), {
			cause: error,
		});
	try {
		if (!statSync(file).isFile()) throw new ClientError(`'${file}' is not a file`);
	} catch (error: any) {
		if (error instanceof ClientError) throw error;
		throw unreadable(error);
	}
	let stagingDir: string;
	try {
		({ stagingDir } = await stageArchive(() => createReadStream(file), {
			databaseName,
			databaseDir,
			blobRoots,
			acceptIncompatible: options.acceptIncompatible,
			sha256: options.sha256,
			restoredFrom: file,
		}));
	} catch (error: any) {
		throw error?.path === file && typeof error.code === 'string' ? unreadable(error) : error;
	}
	return restoreStagedArchive(
		{
			databaseName,
			databaseDir,
			stagingId: basename(stagingDir),
			acceptUnverifiedBlobs: options.acceptUnverifiedBlobs,
		},
		(staged) =>
			publishRestore({
				route: 'offline',
				sourceDatabase: databaseName,
				targetDatabase: databaseName,
				inPlace: true,
				backupDir: backupDirForDatabase(databaseName),
				databaseDir,
				blobRoots,
				allowEngineOnly: false,
				acceptIncompatible: options.acceptIncompatible,
				acceptUnverifiedBlobs: options.acceptUnverifiedBlobs,
				immutableSource: false,
				checkPeers: databaseName === 'system' ? 'routes' : true,
				probeEngineLock: true,
				staged,
			})
	);
}

/** `resume=true` on an interrupted online or offline archive restore, with Harper stopped. */
export async function resumeArchiveRestoreOffline(databaseName: string) {
	validateDatabaseName(databaseName);
	const databaseDir = resolveDatabasePath(databaseName);
	const read = readRestoreReceipt(databaseDir);
	const receipt = read.kind === 'valid' ? read.receipt : undefined;
	if (!receipt || !isStagedReceipt(receipt) || receipt.route === 'on_restart' || receipt.state !== 'applying') {
		throw new ClientError(`Database '${databaseName}' has no interrupted archive restore to resume`, 404);
	}
	return publishRestore({
		route: 'offline',
		sourceDatabase: receipt.source_database,
		targetDatabase: databaseName,
		inPlace: true,
		backupDir: receipt.backup_dir,
		databaseDir,
		blobRoots: getBlobPathsForDatabaseName(databaseName),
		allowEngineOnly: false,
		acceptIncompatible: receipt.options.accept_incompatible_backup === true,
		acceptUnverifiedBlobs: receipt.options.accept_unverified_blobs === true,
		immutableSource: false,
		checkPeers: databaseName === 'system' ? 'routes' : true,
		probeEngineLock: true,
		staged: {
			stagingDir: receipt.staging_dir!,
			restoredFrom: receipt.restored_from ?? 'archive',
			archiveSha256: receipt.archive_sha256 ?? '',
			resume: true,
		},
	});
}
