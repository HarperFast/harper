import { closeSync, existsSync, fsyncSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { chmod, readdir, stat } from 'node:fs/promises';
import { RocksDatabase, backups } from '@harperfast/rocksdb-js';
import { initSync, setProperty } from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { isUnsupportedSyncError } from '../utility/fsync.ts';
import { stampDatabaseDirectory } from '../resources/auditStore.ts';
import { openRestoredGeneration, closeRestoredGeneration } from '../resources/databases.ts';
import { replayLogs, type ReplaySummary } from '../resources/replayLogs.ts';
import { assessBlobReferences, type BlobReferenceAssessment } from '../resources/blob.ts';
import { restoreBlobSnapshot } from './blobBackup.ts';
import type { BackupManifest } from './backupManifest.ts';
import { readRestoreReceipt } from './restoreReceipt.ts';
import type { ReceiptAuthorization, RestoreChildCommand, RestoreChildSpec } from './restoreChildRunner.ts';
import { assertBackupReadable, BackupInProgressError, isRocksDbLockError, verifyBackupFiles } from './rocksdbBackup.ts';

export function initializeRestoreChildEnvironment(spec: RestoreChildSpec): void {
	initSync();
	for (const [name, value] of Object.entries(spec.configOverrides ?? {})) setProperty(name, value);
	setProperty(CONFIG_PARAMS.STORAGE_ROCKS_BLOCKCACHESIZE, spec.blockCacheSize);
	setProperty(CONFIG_PARAMS.STORAGE_ROCKS_WRITEBUFFERMANAGERSIZE, spec.writeBufferManagerSize);
}

/** True only while the receipt on disk still names the attempt this child was started for. */
export function assertReceiptAuthorizes(authorization: ReceiptAuthorization): boolean {
	const read = readRestoreReceipt(authorization.databasePath);
	return (
		read.kind === 'valid' &&
		read.receipt.operation_id === authorization.operationId &&
		read.receipt.attempts === authorization.attempt &&
		read.receipt.state === (authorization.state ?? 'applying')
	);
}

interface ApplyAndProveArgs {
	operationId?: string;
	databaseName: string;
	sourceDatabase: string;
	databasePath: string;
	backupDir: string;
	backupId: number;
	manifest: BackupManifest;
	blobRoots: string[];
	probe: boolean;
	interrupted: boolean;
	acceptUnverifiedBlobs?: boolean;
}

export interface RestoreEvidence {
	tables: string[];
	required_stores: Record<string, string[]>;
	replay: ReplaySummary;
	blobs: Omit<BlobReferenceAssessment, 'blobIntegrity'> & { blob_integrity: string; waived?: boolean };
	durability: 'full' | 'no-directory-fsync';
}

async function probeEngineLock(databaseName: string, databasePath: string): Promise<void> {
	if (!existsSync(join(databasePath, 'CURRENT'))) return;
	let handle: RocksDatabase | undefined;
	try {
		handle = RocksDatabase.open(databasePath);
	} catch (error: any) {
		if (isRocksDbLockError(error)) {
			throw new BackupInProgressError(
				`Cannot restore database '${databaseName}': it is open by a running Harper process — stop Harper before restoring offline`
			);
		}
		// corrupt or half-restored: exactly what the restore recovers
	}
	handle?.close();
}

/** Where an apply-and-prove failed: only `verify` and `probe` leave the target untouched. */
type RestorePhase = 'verify' | 'probe' | 'apply' | 'prove';

async function inPhase<T>(phase: RestorePhase, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error: any) {
		if (error && typeof error === 'object' && error.phase === undefined) error.phase = phase;
		throw error;
	}
}

const DESTRUCTION_PERMIT_TIMEOUT_MS = 30_000;

/** Tells the parent the purge is next and waits for it to mark the target; outside a child, a no-op. */
function announceDestruction(): Promise<void> {
	if (!process.send) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const onMessage = (message: any) => {
			if (message?.type !== 'proceed') return;
			clearTimeout(timer);
			process.off('message', onMessage);
			resolve();
		};
		const timer = setTimeout(() => {
			process.off('message', onMessage);
			reject(new Error('The restoring process never permitted the purge'));
		}, DESTRUCTION_PERMIT_TIMEOUT_MS);
		process.on('message', onMessage);
		process.send!({ type: 'destroying' });
	});
}

async function applyAndProve(args: ApplyAndProveArgs): Promise<RestoreEvidence> {
	await inPhase('verify', () =>
		assertBackupReadable(
			args.backupDir,
			args.backupId,
			args.manifest,
			args.sourceDatabase,
			args.databaseName,
			() => args.interrupted
		)
	);
	if (args.probe) await inPhase('probe', () => probeEngineLock(args.databaseName, args.databasePath));
	await inPhase('apply', async () => {
		await announceDestruction();
		// an engine-only backup leaves the live blob roots as they are, so it has no reason to touch them
		const roots = args.manifest.blobs ? [args.databasePath, ...args.blobRoots] : [args.databasePath];
		// a copy keeps its source's mode, so a read-only repository (`immutable_source`) yields read-only
		// transaction logs and blobs: before the purge, so debris an earlier attempt left can be removed,
		// and after the copy, so the new generation is one this database can write
		for (const root of roots) await makeOwnerWritable(root);
		await backups.restore(args.backupDir, args.databasePath, { backupId: args.backupId, mode: 'purgeAllFiles' });
		if (args.manifest.blobs) {
			await restoreBlobSnapshot(args.backupDir, args.backupId, args.sourceDatabase, args.blobRoots, {
				durable: true,
			});
		}
		for (const root of roots) await makeOwnerWritable(root);
		await stampDatabaseDirectory(args.databasePath, { carriesLog: true });
	});
	return inPhase('prove', () => prove(args));
}

async function makeOwnerWritable(root: string): Promise<void> {
	let entries;
	try {
		await addMode(root, 0o700);
		entries = await readdir(root, { withFileTypes: true });
	} catch (error: any) {
		if (error.code === 'ENOENT') return;
		throw error;
	}
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) await makeOwnerWritable(path);
		else if (entry.isFile()) await addMode(path, 0o600);
	}
}

async function addMode(path: string, bits: number): Promise<void> {
	const { mode } = await stat(path);
	if ((mode & bits) !== bits) await chmod(path, mode | bits);
}

/** Whether this filesystem flushes a directory's entries, which the durable writes above tolerated silently. */
function directoryFsyncSupported(directory: string): boolean {
	let fd: number;
	try {
		fd = openSync(directory, 'r');
	} catch (error) {
		if (isUnsupportedSyncError(error)) return false;
		throw error;
	}
	try {
		fsyncSync(fd);
		return true;
	} catch (error) {
		if (isUnsupportedSyncError(error)) return false;
		throw error;
	} finally {
		closeSync(fd);
	}
}

async function prove(args: ApplyAndProveArgs): Promise<RestoreEvidence> {
	const generation = openRestoredGeneration(args.databasePath, args.databaseName);
	let evidence: RestoreEvidence;
	try {
		const missingTables = [...generation.requiredStores.keys()].filter((table) => !generation.tables[table]);
		if (missingTables.length > 0) {
			throw new Error(
				`The restored ${args.databaseName} database did not load table(s) the backup contains: ${missingTables.join(', ')}`
			);
		}
		const replay = (await replayLogs(generation.rootStore, generation.tables, { policy: 'restore' })) as ReplaySummary;
		// the scan is also the strict read of every record, so the waiver relaxes only the blob verdict
		const { blobIntegrity, ...assessment } = await assessBlobReferences(generation.tables);
		if (blobIntegrity === 'failed' && !args.acceptUnverifiedBlobs) {
			throw new ClientError(
				`The restored ${args.databaseName} database references blob files the backup does not contain (${assessment.failures
					.map((failure) => `${failure.table} ${JSON.stringify(failure.id)}: ${failure.state}`)
					.join('; ')}); rerun with accept_unverified_blobs=true to publish it anyway`,
				409
			);
		}
		const blobs: RestoreEvidence['blobs'] =
			blobIntegrity === 'failed'
				? { blob_integrity: 'unverified', waived: true, ...assessment }
				: { blob_integrity: blobIntegrity, ...assessment };
		await (generation.rootStore as any).flush?.();
		evidence = {
			tables: Object.keys(generation.tables),
			required_stores: Object.fromEntries(generation.requiredStores),
			replay,
			blobs,
			durability: directoryFsyncSupported(args.databasePath) ? 'full' : 'no-directory-fsync',
		};
	} catch (error) {
		closeRestoredGeneration(args.databasePath, generation);
		throw error;
	}
	const closeFailures = closeRestoredGeneration(args.databasePath, generation);
	if (closeFailures.length > 0) {
		throw new AggregateError(closeFailures, `The restored ${args.databaseName} database did not close cleanly`);
	}
	return evidence;
}

export async function runRestoreChildCommand(command: RestoreChildCommand, args: any): Promise<unknown> {
	switch (command) {
		case 'verify':
			await verifyBackupFiles(
				args.backupDir,
				args.backupId,
				args.manifest,
				args.databaseName,
				args.verifyWithChecksum,
				args.verifyTables
			);
			return { ok: true };
		case 'apply-and-prove':
			return applyAndProve(args);
		default:
			throw new Error(`Unknown restore child command ${command}`);
	}
}
