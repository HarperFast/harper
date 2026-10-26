/**
 * `import_backup`: turns a `get_backup` archive into a verified managed backup in the database's
 * repository — no restore, no restart. Three sources, one pipeline once the bytes are on disk:
 *
 * - `source_file`: an archive already under `<backupsRoot>/<db>/.import/`, typically a mount the
 *   operator attached (it may be read-only; nothing is written there);
 * - a multipart upload, spooled raw — no gzip or tar work on the serving thread — into staging;
 * - `url` (https) or `s3`, fetched by the job.
 *
 * Extraction, validation, conversion and verification all run in the bounded restore child, whose
 * instance slot is the one-import-at-a-time rule and whose OS-released locks survive a dead job
 * thread. Staging lives at `<backupsRoot>/<db>/.staging/<importId>/`; Harper creates `.import` and
 * `.staging` but only ever removes `<importId>` entries, since either may be a mount point.
 */
import { loadRuntimeModule } from '../utility/packageUtils.js';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { isMainThread, parentPort, threadId } from 'node:worker_threads';
import { ClientError } from '../utility/errors/hdbError.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
import { writeFileDurably, fsyncDirectory } from '../utility/durableFile.ts';
import logger from '../utility/logging/harper_logger.ts';
import { getSecretCustody } from '../resources/secretDecryptor.ts';
import { redactUrl } from '../utility/safeFetch.ts';
import { getStorageSpaceStats } from '../server/storageReclamation.ts';
import { runRestoreChild } from './restoreChildRunner.ts';
import { DiskLedger, ledgerMeter } from './diskLedger.ts';
import {
	backupDirForDatabase,
	getBackupsRoot,
	getDatabaseName,
	requireBooleanOption,
	requireSuperUser,
} from './rocksdbBackup.ts';

export const IMPORT_SOURCE_DIR = '.import';
export const IMPORT_STAGING_DIR = '.staging';
const OWNER_FILE = 'owner.json';
const SPOOL_FILE = 'archive';
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const SECRET_REQUEST_TIMEOUT_MS = 30_000;
const IMPORT_CHILD_TIMEOUT_MS = 30 * 60 * 60 * 1000;
const IMPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWED_S3_FIELDS = new Set(['bucket', 'key', 'region', 'credentials']);

export function importStagingDir(databaseName: string, importId: string): string {
	return join(backupDirForDatabase(databaseName), IMPORT_STAGING_DIR, importId);
}

/** Redacts an import request for logs and job rows shown back to the caller. */
export function describeImportSource(request: any): string {
	if (request.source_file !== undefined) return `${IMPORT_SOURCE_DIR}/${request.source_file}`;
	if (request.url !== undefined) return redactUrl(request.url);
	if (request.s3 !== undefined) return `s3://${request.s3.bucket}/${request.s3.key}`;
	return 'upload';
}

function isUpload(payload: unknown): payload is Readable {
	return typeof (payload as Readable)?.pipe === 'function';
}

function countSources(request: any): number {
	const fields = ['source_file', 'url', 's3', 'staging_id'].filter((field) => request[field] !== undefined).length;
	return fields + (isUpload(request.payload) ? 1 : 0);
}

/** Request-time validation, before a job row exists: nothing secret-bearing is persisted unvalidated. */
export function validateImportBackup(request: any): void {
	requireSuperUser(request, hdbTerms.OPERATIONS_ENUM.IMPORT_BACKUP);
	getDatabaseName(request);
	requireBooleanOption(request.accept_incompatible_backup, 'accept_incompatible_backup');
	if (countSources(request) !== 1) {
		throw new ClientError(`import_backup needs exactly one source: source_file, a multipart upload, url, or s3`);
	}
	// the job removes this directory when it finishes, so it must name an area spoolUpload created
	if (request.staging_id !== undefined && !IMPORT_ID_PATTERN.test(request.staging_id)) {
		throw new ClientError(`'staging_id' is not a staged upload`);
	}
	if (request.source_file !== undefined) {
		const name = request.source_file;
		if (typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\') || name === '..') {
			throw new ClientError(`'source_file' must be the name of a file in ${IMPORT_SOURCE_DIR}/`);
		}
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

/** The operation: spools an upload if there is one, then queues the import job. */
export async function importBackup(request: any): Promise<{ message: string; job_id: string }> {
	requireSuperUser(request, hdbTerms.OPERATIONS_ENUM.IMPORT_BACKUP);
	if (request.staging_id !== undefined || request.upload_digest !== undefined) {
		throw new ClientError(`'staging_id' and 'upload_digest' are set by the server for an upload`);
	}
	validateImportBackup(request);
	const { executeJob } = await import('../server/serverHelpers/serverUtilities.ts');
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
				logger.error('Could not sweep the import staging of an exited thread', error);
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
		logger.debug?.('import_backup secret requests are unavailable on this process', error);
	}
}

async function rolesMissingLocally(roles: unknown): Promise<string[]> {
	if (!Array.isArray(roles) || roles.length === 0) return [];
	try {
		const { getDatabases } = await import('../resources/databases.ts');
		const roleTable: any = getDatabases().system?.[hdbTerms.SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME];
		if (!roleTable) return [];
		const existing = new Set<string>();
		for await (const role of roleTable.search([])) existing.add(role.role ?? role.id);
		return roles.filter((role) => typeof role === 'string' && !existing.has(role));
	} catch (error) {
		logger.debug?.('Could not compare imported role names with local roles', error);
		return [];
	}
}

/** The job: everything after the bytes are on disk — or the fetch that puts them there — in the child. */
export async function importBackupJob(request: any) {
	const databaseName = getDatabaseName(request);
	const backupDir = backupDirForDatabase(databaseName);
	const importId: string = request.staging_id ?? randomUUID();
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
	try {
		const result: any = await runRestoreChild(
			'import-archive',
			{
				databaseName,
				backupDir,
				importId,
				stagingDir: importStagingDir(databaseName, importId),
				sourceFile: request.source_file,
				url: request.url,
				s3,
				// an upload's own digest pins the bytes the job reads back from staging
				sha256: request.sha256 ?? request.upload_digest ?? undefined,
				acceptIncompatible: request.accept_incompatible_backup === true,
				importedFrom: describeImportSource(request),
			},
			// a pull may itself take a day, before extraction and conversion
			{ timeoutMs: IMPORT_CHILD_TIMEOUT_MS }
		);
		return { ...result, missing_roles: await rolesMissingLocally(result.roles) };
	} finally {
		rmSync(importStagingDir(databaseName, importId), { recursive: true, force: true });
	}
}

/**
 * Removes staging that no live import owns: a thread-owned area whose thread is gone (on its exit),
 * and, at boot, any area whose owner is not a running job. `owner` is undefined for an area with no
 * owner record — a pull or `source_file` import in flight, or an upload whose record is not yet written.
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
			if (isOwned(owner)) continue;
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

/** Before anything serves: every import job of an earlier process is dead, so none of its staging is owned. */
export function sweepImportStagingAtStartup(): void {
	if (startupSweepRan) return;
	startupSweepRan = true;
	try {
		const removed = sweepImportStaging(() => false);
		if (removed > 0) logger.info(`Removed ${removed} import staging area(s) left by an earlier process`);
	} catch (error) {
		logger.error('Could not sweep import staging at startup', error);
	}
}
