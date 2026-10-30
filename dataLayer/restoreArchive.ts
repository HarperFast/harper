/**
 * `restore_backup` from a `get_backup` archive instead of a managed backup. The archive is staged into
 * `<backupsRoot>/<db>/.staging/<id>/` — never the database's own repository — as an extracted,
 * verified tree, which the restore child installs into the target (dataLayer/stagedTreeInstall.ts).
 * Sources:
 *
 * - a multipart upload, spooled raw — no gzip or tar work on the serving thread — into staging;
 * - `server_path`: a file on this machine, read in place (never copied or removed), accepted only
 *   when `server_path_identity` matches it, which a caller can know only from this machine; the
 *   CLI's `file=` sends it for a local server and uploads otherwise;
 * - `url` (https) or `s3`, fetched by the job.
 *
 * Extraction, validation and conversion run in the bounded restore child. A staging area lives while
 * its job runs, and afterwards for as long as a pin in it is live — a failed restore that
 * began replacing its target keeps its only source. Harper creates `.staging` but only ever removes
 * `<id>` entries, since it may be a mount point.
 */
import { loadRuntimeModule } from '../utility/packageUtils.js';
import { createHash, randomUUID } from 'node:crypto';
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	type Stats,
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { isMainThread, parentPort, threadId } from 'node:worker_threads';
import { ClientError } from '../utility/errors/hdbError.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
import { writeFileDurably, fsyncDirectory } from '../utility/durableFile.ts';
import logger from '../utility/logging/harper_logger.ts';
import { getSecretCustody } from '../resources/secretDecryptor.ts';
import { redactUrl } from '../utility/safeFetch.ts';
import { fileIdentity, isFileIdentity, sameFileIdentity, type FileIdentity } from '../utility/fileIdentity.ts';
import { getStorageSpaceStats } from '../server/storageReclamation.ts';
import { runRestoreChild } from './restoreChildRunner.ts';
import { hasLivePin, readBackupPins } from './backupRepository.ts';
import { readStagedSource, STAGED_TREE_BACKUP_ID } from './archiveStaging.ts';
import type { BackupManifest } from './backupManifest.ts';
import type { RestoreSourceKind } from './restoreReceipt.ts';
import { DiskLedger, ledgerMeter } from './diskLedger.ts';
import { backupDirForDatabase, getBackupsRoot, getDatabaseName, requireSuperUser } from './rocksdbBackup.ts';

export const IMPORT_STAGING_DIR = '.staging';
const OWNER_FILE = 'owner.json';
const SPOOL_FILE = 'archive';
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const SECRET_REQUEST_TIMEOUT_MS = 30_000;
const STAGE_CHILD_TIMEOUT_MS = 30 * 60 * 60 * 1000;
const IMPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWED_S3_FIELDS = new Set(['bucket', 'key', 'region', 'credentials']);

export function importStagingDir(databaseName: string, importId: string): string {
	return join(backupDirForDatabase(databaseName), IMPORT_STAGING_DIR, importId);
}

/** Where an archive restore came from, redacted for logs, job rows and results. */
function describeArchiveSource(request: any): string {
	if (request.server_path !== undefined) return request.server_path;
	if (request.url !== undefined) return redactUrl(request.url);
	if (request.s3 !== undefined) return `s3://${request.s3.bucket}/${request.s3.key}`;
	return 'upload';
}

function isUpload(payload: unknown): payload is Readable {
	return typeof (payload as Readable)?.pipe === 'function';
}

function countArchiveSources(request: any): number {
	const fields = ['server_path', 'url', 's3', 'staging_id'].filter((field) => request[field] !== undefined).length;
	return fields + (isUpload(request.payload) ? 1 : 0);
}

export function hasArchiveSource(request: any): boolean {
	// any payload counts, so one that is not an upload is refused rather than read as "no archive"
	return (
		countArchiveSources(request) > 0 || request.server_path_identity !== undefined || request.payload !== undefined
	);
}

/**
 * The archive half of a restore request, checked before any job row exists or any byte is spooled, so
 * nothing secret-bearing is persisted unvalidated.
 */
export function validateArchiveSource(request: any): void {
	const refuse = (message: string) => {
		throw new ClientError(message);
	};
	if (request.payload !== undefined && !isUpload(request.payload)) {
		refuse(`'payload' must be the archive as a multipart upload; from the CLI, pass file=<path>`);
	}
	if (countArchiveSources(request) > 1) {
		refuse(`restore_backup takes one archive: file=<path> from the CLI (or a multipart 'payload' upload), url, or s3`);
	}
	if (request.backup_id !== undefined)
		refuse(`'backup_id' names a managed backup; omit it when restoring from an archive`);
	if (request.immutable_source !== undefined) refuse(`'immutable_source' does not apply to an archive`);
	if (request.resume !== undefined || request.cancel !== undefined) {
		refuse(`'resume' and 'cancel' act on a pending restore; send them without an archive`);
	}
	// the job removes this directory when it finishes, so it must name an area spoolUpload created
	if (request.staging_id !== undefined && !IMPORT_ID_PATTERN.test(request.staging_id)) {
		throw new ClientError(`'staging_id' is not a staged upload`);
	}
	if (request.server_path !== undefined) {
		if (typeof request.server_path !== 'string' || !isAbsolute(request.server_path)) {
			throw new ClientError(`'server_path' must be an absolute path`);
		}
		if (!isFileIdentity(request.server_path_identity)) {
			throw new ClientError(`'server_path' needs 'server_path_identity': { dev, ino, size, mtime_ms } of the file`);
		}
	} else if (request.server_path_identity !== undefined) {
		throw new ClientError(`'server_path_identity' is only for a 'server_path'`);
	}
	if (request.url !== undefined && (typeof request.url !== 'string' || !request.url.startsWith('https://'))) {
		throw new ClientError(`'url' must be an https URL`);
	}
	if (request.s3 !== undefined) {
		const s3 = request.s3;
		if (!s3 || typeof s3 !== 'object' || typeof s3.bucket !== 'string' || typeof s3.key !== 'string') {
			throw new ClientError(`'s3' must name a bucket and a key`);
		}
		const extra = Object.keys(s3).filter((field) => !ALLOWED_S3_FIELDS.has(field));
		const credentials = s3.credentials;
		if (
			extra.length > 0 ||
			!credentials ||
			typeof credentials !== 'object' ||
			typeof credentials.secret !== 'string' ||
			Object.keys(credentials).length !== 1
		) {
			// An inline key would be persisted in the job row; only a reference to a stored secret is accepted.
			throw new ClientError(
				`'s3' accepts only bucket, key, region and credentials: { secret: '<name of a processEnv secret>' }; inline keys are refused`
			);
		}
	}
	if (
		request.declared_size !== undefined &&
		(!Number.isSafeInteger(request.declared_size) || request.declared_size < 0)
	) {
		throw new ClientError(`'declared_size' must be a non-negative integer`);
	}
	if (request.sha256 !== undefined && (typeof request.sha256 !== 'string' || !SHA256_PATTERN.test(request.sha256))) {
		throw new ClientError(`'sha256' must be 64 hexadecimal characters`);
	}
}

/**
 * A `server_path` archive, only when it is the very file its identity describes: a missing file and a
 * different one answer alike (412), so a caller on another machine learns nothing about this one's
 * files, and the CLI knows to upload instead.
 */
export function resolveServerPath(serverPath: string, identity: FileIdentity): string {
	let stats: Stats | undefined;
	try {
		stats = statSync(serverPath);
	} catch {
		stats = undefined;
	}
	if (!stats?.isFile() || !sameFileIdentity(fileIdentity(stats), identity)) {
		throw new ClientError(
			`'${serverPath}' is not the file the request describes on this server; send it with file=<path> from the CLI or as a multipart upload`,
			412
		);
	}
	return serverPath;
}

function writeOwner(dir: string, owner: Record<string, unknown>): void {
	writeFileDurably(join(dir, OWNER_FILE), JSON.stringify(owner), `${OWNER_FILE}.tmp`);
}

/**
 * Streams a multipart upload, as raw bytes, into a fresh staging area this thread owns until the
 * upload is whole, then hands the area to the import (by rewriting its owner) before any job row
 * names it — so a thread that dies mid-upload leaves staging its exit sweep removes, and a thread that
 * dies after the hand-off leaves staging only the boot sweep can, once no job owns it.
 */
async function spoolUpload(databaseName: string, payload: Readable, declaredSize?: number) {
	const importId = randomUUID();
	const stagingRoot = join(backupDirForDatabase(databaseName), IMPORT_STAGING_DIR);
	if (!existsSync(stagingRoot)) {
		mkdirSync(stagingRoot, { recursive: true });
		fsyncDirectory(join(stagingRoot, '..'));
	}
	if (declaredSize !== undefined) {
		const { available } = await getStorageSpaceStats(stagingRoot);
		if (declaredSize > available) {
			payload.resume();
			throw new ClientError(
				`The upload declares ${declaredSize} bytes, but only ${available} are available for staging`,
				507
			);
		}
	}
	const dir = join(stagingRoot, importId);
	mkdirSync(dir);
	writeOwner(dir, { owner: 'thread', thread_id: threadId, process_instance: processInstance() });
	const hash = createHash('sha256');
	let bytes = 0;
	// the declared size is only advisory; the ledger stops a spool that outgrows the staging device
	const meter = ledgerMeter(new DiskLedger(), dir, {
		onChunk(chunk) {
			hash.update(chunk);
			bytes += chunk.length;
		},
	});
	try {
		await pipeline(payload, meter, createWriteStream(join(dir, SPOOL_FILE), { flags: 'wx' }));
		writeOwner(dir, { owner: 'import', import_id: importId });
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
	return { importId, digest: hash.digest('hex'), bytes };
}

function processInstance(): string | undefined {
	return loadRuntimeModule('server/threads/manageThreads').processIncarnation;
}

/**
 * The `restore_backup` operation. Without an archive it is the job as it always was; with one it checks
 * the whole request first, spools an upload, and queues the job with the archive's staging named.
 */
export async function restoreBackupRequest(request: any): Promise<{ message: string; job_id: string }> {
	requireSuperUser(request, hdbTerms.OPERATIONS_ENUM.RESTORE_BACKUP);
	if (request.staging_id !== undefined || request.upload_digest !== undefined) {
		throw new ClientError(`'staging_id' and 'upload_digest' are set by the server for an upload`);
	}
	const { executeJob } = await import('../server/serverHelpers/serverUtilities.ts');
	if (!hasArchiveSource(request)) return executeJob(request);
	const { validateRestoreBackup } = await import('./rocksdbBackup.ts');
	await validateRestoreBackup(request);
	if (request.server_path !== undefined) resolveServerPath(request.server_path, request.server_path_identity);
	if (!isUpload(request.payload)) {
		// a presigned URL is a bearer credential, and the job row outlives the job in every system backup
		if (typeof request.url === 'string' && redactUrl(request.url) !== request.url) {
			return executeJob({ ...request, url: redactUrl(request.url) }, { url: request.url });
		}
		return executeJob(request);
	}
	const databaseName = getDatabaseName(request);
	const { payload, ...rest } = request;
	const spooled = await spoolUpload(databaseName, payload, rest.declared_size);
	try {
		return await executeJob({ ...rest, staging_id: spooled.importId, upload_digest: spooled.digest });
	} catch (error) {
		rmSync(importStagingDir(databaseName, spooled.importId), { recursive: true, force: true });
		throw error;
	}
}

/** Resolves an S3 credential reference: on this thread if it holds custody, else from the main thread. */
async function resolveImportSecret(name: string): Promise<string> {
	if (getSecretCustody() || isMainThread) {
		const { resolveProcessSecret } = await import('../components/secretOperations.ts');
		return resolveProcessSecret(name);
	}
	return new Promise((resolve, reject) => {
		const requestId = randomUUID();
		const onMessage = (message: any) => {
			if (message?.type !== hdbTerms.ITC_EVENT_TYPES.IMPORT_SECRET_RESPONSE || message.requestId !== requestId) return;
			clearTimeout(timer);
			parentPort!.off('message', onMessage);
			if (message.error) reject(new ClientError(message.error, message.statusCode ?? 500));
			else resolve(message.value);
		};
		const timer = setTimeout(() => {
			parentPort!.off('message', onMessage);
			reject(new ClientError(`The main thread did not resolve secret '${name}' in time`, 504));
		}, SECRET_REQUEST_TIMEOUT_MS);
		parentPort!.on('message', onMessage);
		parentPort!.postMessage({ type: hdbTerms.ITC_EVENT_TYPES.IMPORT_SECRET_REQUEST, requestId, name });
	});
}

if (isMainThread) {
	try {
		const { onMessageByType, onThreadExit } = loadRuntimeModule('server/threads/manageThreads');
		onThreadExit((exitedThreadId: number) => {
			try {
				sweepExitedThreadStaging(exitedThreadId);
			} catch (error) {
				logger.error('Could not sweep the restore staging of an exited thread', error);
			}
		});
		onMessageByType(hdbTerms.ITC_EVENT_TYPES.IMPORT_SECRET_REQUEST, async (message: any, port: any) => {
			const reply: Record<string, unknown> = {
				type: hdbTerms.ITC_EVENT_TYPES.IMPORT_SECRET_RESPONSE,
				requestId: message.requestId,
			};
			try {
				const { resolveProcessSecret } = await import('../components/secretOperations.ts');
				reply.value = await resolveProcessSecret(message.name);
			} catch (error: any) {
				reply.error = error?.message ?? String(error);
				reply.statusCode = error?.statusCode;
			}
			try {
				port?.postMessage(reply);
			} catch {
				// the requesting job is gone
			}
		});
	} catch (error) {
		logger.debug?.('restore archive secret requests are unavailable on this process', error);
	}
}

async function rolesMissingLocally(roles: unknown): Promise<string[]> {
	if (!Array.isArray(roles) || roles.length === 0) return [];
	try {
		const { databases, databasesLoaded } = await import('../resources/databases.ts');
		// never scan: an offline CLI has opened nothing, and a scan would open the target it is restoring
		if (!databasesLoaded()) return [];
		const roleTable: any = (databases as any).system?.[hdbTerms.SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME];
		if (!roleTable) return [];
		const existing = new Set<string>();
		for await (const role of roleTable.search([])) existing.add(role.role ?? role.id);
		return roles.filter((role) => typeof role === 'string' && !existing.has(role));
	} catch (error) {
		logger.debug?.("Could not compare the archive's role names with local roles", error);
		return [];
	}
}

export interface StagedArchive {
	stagingDir: string;
	backupDir: string;
	backupId: number;
	restoredFrom: string;
	tables: string[];
	compatibilityWaived: string[];
	missingRoles: string[];
}

/** In the restore job: everything after the bytes are on disk — or the fetch that puts them there — in the child. */
export async function stageArchiveForRestore(request: any, databaseName: string): Promise<StagedArchive> {
	const stageId: string = request.staging_id ?? randomUUID();
	const stagingDir = importStagingDir(databaseName, stageId);
	let s3: Record<string, unknown> | undefined;
	if (request.s3) {
		s3 = { bucket: request.s3.bucket, key: request.s3.key, region: request.s3.region };
		if (request.s3.credentials?.secret) {
			const secret = await resolveImportSecret(request.s3.credentials.secret);
			let parsed: any;
			try {
				parsed = JSON.parse(secret);
			} catch {
				parsed = undefined;
			}
			if (!parsed?.accessKeyId || !parsed?.secretAccessKey) {
				throw new ClientError(
					`secret '${request.s3.credentials.secret}' must hold JSON with accessKeyId and secretAccessKey`
				);
			}
			s3.credentials = parsed;
		}
	}
	const restoredFrom = describeArchiveSource(request);
	try {
		const staged: any = await runRestoreChild(
			'stage-archive',
			{
				databaseName,
				stagingDir,
				serverPath: request.server_path,
				serverPathIdentity: request.server_path_identity,
				url: request.url,
				s3,
				// an upload's own digest pins the bytes the job reads back from staging
				sha256: request.sha256 ?? request.upload_digest ?? undefined,
				acceptIncompatible: request.accept_incompatible_backup === true,
				restoredFrom,
			},
			// a pull may itself take a day, before extraction and conversion
			{ timeoutMs: STAGE_CHILD_TIMEOUT_MS }
		);
		return {
			stagingDir,
			backupDir: staged.backupDir,
			backupId: staged.backupId,
			restoredFrom,
			tables: staged.tables,
			compatibilityWaived: staged.compatibility_waived ?? [],
			missingRoles: await rolesMissingLocally(staged.roles),
		};
	} catch (error: any) {
		rmSync(stagingDir, { recursive: true, force: true });
		if (error?.refused && request.staging_id !== undefined) {
			throw new ClientError(`${error.message}; the uploaded archive was not kept, so send it again`, 409);
		}
		throw error;
	}
}

/**
 * The backup a restore applies: a managed backup from its repository, or the staged archive in a
 * staging area, which presents as one backup with the manifest staging recorded.
 */
export async function resolveRestoreSource(source: {
	kind?: RestoreSourceKind;
	backupDir: string;
	requestedBackupId?: number;
	sourceDatabase: string;
	acceptIncompatible: boolean;
	blobRoots: string[];
}): Promise<{ backupId: number; manifest: BackupManifest; waived: string[] }> {
	if (source.kind === 'staged_tree') {
		const staged = readStagedSource(source.backupDir);
		const beyond = staged.manifest.blobs ? staged.blobIndices.filter((index) => index >= source.blobRoots.length) : [];
		if (beyond.length > 0) {
			throw new ClientError(
				`The archive has blob root(s) ${beyond.join(', ')}, but this instance has ${source.blobRoots.length} blob path(s); configure matching storage.blobPaths before restoring`
			);
		}
		return { backupId: STAGED_TREE_BACKUP_ID, manifest: staged.manifest, waived: staged.waived };
	}
	const { resolveCompleteBackup, restoreSourceHint } = await import('./rocksdbBackup.ts');
	const { assertBlobSnapshotRestorable } = await import('./blobBackup.ts');
	let selected: Awaited<ReturnType<typeof resolveCompleteBackup>>;
	try {
		selected = await resolveCompleteBackup(
			source.backupDir,
			source.requestedBackupId,
			source.sourceDatabase,
			source.acceptIncompatible
		);
	} catch (error) {
		throw restoreSourceHint(error, source.sourceDatabase, source.requestedBackupId);
	}
	await assertBlobSnapshotRestorable(source.backupDir, selected.backupId, source.blobRoots);
	return selected;
}

/**
 * Removes a staging area once nothing depends on it: no pin in its repository is live. A failed restore
 * that began replacing its target keeps its pin live through the marker, so its source survives for the
 * rerun; cleanup that cannot run now is left for the next sweep, never turned into a failed restore.
 */
export function releaseStagingIfUnowned(stagingDir: string): boolean {
	try {
		if (hasLivePin(stagingDir)) return false;
		rmSync(stagingDir, { recursive: true, force: true });
		return true;
	} catch (error) {
		logger.warn(`Could not remove the restore staging area ${stagingDir}; the next sweep retries`, error);
		return false;
	}
}

/** Once a restore stops depending on a staged archive: removes its area when no pin keeps it. */
export function releaseArchiveStaging(source: { backup_dir: string; source_kind?: RestoreSourceKind }): void {
	// only the kind decides: a backups root that happens to end in `.staging` is still a real repository
	if (source.source_kind === 'staged_tree' && basename(join(source.backup_dir, '..')) === IMPORT_STAGING_DIR) {
		releaseStagingIfUnowned(source.backup_dir);
	}
}

/**
 * Every staging area, under any database, that some restore pinned and nothing holds any longer: a chain
 * of failed attempts at one target leaves one per attempt, possibly from different source databases,
 * and a rerun takes over only the latest. An area no restore ever pinned is still being staged, so it is
 * left alone.
 */
export function releaseLapsedStaging(): void {
	const stagingDirs: string[] = [];
	const list = (directory: string): string[] => {
		try {
			return existsSync(directory) ? readdirSync(directory) : [];
		} catch (error) {
			logger.warn(`Could not list ${directory} for lapsed restore staging; the next sweep retries`, error);
			return [];
		}
	};
	const backupsRoot: string = getBackupsRoot();
	for (const database of list(backupsRoot)) {
		const stagingRoot = join(backupsRoot, database, IMPORT_STAGING_DIR);
		for (const id of list(stagingRoot)) stagingDirs.push(join(stagingRoot, id));
	}
	for (const stagingDir of stagingDirs) {
		try {
			if (readBackupPins(stagingDir).length > 0) releaseStagingIfUnowned(stagingDir);
		} catch (error) {
			logger.warn(`Could not check the restore staging area ${stagingDir}; the next sweep retries`, error);
		}
	}
}

/**
 * Removes staging that nothing owns: a thread-owned area whose thread is gone (on its exit), and, at
 * boot, any area whose owner is not a running job. `owner` is undefined for an area with no owner
 * record — a pull or `server_path` staging in flight, or an upload whose record is not yet written. An
 * area whose repository holds a live pin is always kept: a restore depends on it.
 */
export function sweepImportStaging(isOwned: (owner: any) => boolean): number {
	let removed = 0;
	const backupsRoot: string = getBackupsRoot();
	if (!existsSync(backupsRoot)) return 0;
	for (const database of readdirSync(backupsRoot)) {
		const stagingRoot = join(backupsRoot, database, IMPORT_STAGING_DIR);
		if (!existsSync(stagingRoot)) continue;
		for (const importId of readdirSync(stagingRoot)) {
			const dir = join(stagingRoot, importId);
			let owner: any;
			try {
				owner = JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8'));
			} catch {
				owner = undefined;
			}
			if (isOwned(owner) || hasLivePin(dir)) continue;
			rmSync(dir, { recursive: true, force: true });
			removed++;
		}
	}
	return removed;
}

/** Only an area whose owner record names the exited thread of this process: nothing else is provably dead. */
export function sweepExitedThreadStaging(exitedThreadId: number): number {
	const instance = processInstance();
	return sweepImportStaging(
		(owner) => owner?.owner !== 'thread' || owner.thread_id !== exitedThreadId || owner.process_instance !== instance
	);
}

let startupSweepRan = false;

export function resetImportStagingSweepForTesting(): void {
	startupSweepRan = false;
}

/** After startup recovery: every job of an earlier process is dead, so only a live pin keeps its staging. */
export function sweepImportStagingAtStartup(): void {
	if (startupSweepRan) return;
	startupSweepRan = true;
	try {
		const removed = sweepImportStaging(() => false);
		if (removed > 0) logger.info(`Removed ${removed} restore staging area(s) left by an earlier process`);
	} catch (error) {
		logger.error('Could not sweep restore staging at startup', error);
	}
}
