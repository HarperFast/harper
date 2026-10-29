import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RocksDatabase, backups } from '@harperfast/rocksdb-js';
import { initSync, setProperty } from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { stampDatabaseDirectory } from '../resources/auditStore.ts';
import { openRestoredGeneration, closeRestoredGeneration } from '../resources/databases.ts';
import { replayLogs, type ReplaySummary } from '../resources/replayLogs.ts';
import { assessBlobReferences, type BlobReferenceAssessment } from '../resources/blob.ts';
import { restoreBlobSnapshot } from './blobBackup.ts';
import type { BackupManifest } from './backupManifest.ts';
import type { RestoreSourceKind } from './restoreReceipt.ts';
import { readRestoreReceipt } from './restoreReceipt.ts';
import type { ReceiptAuthorization, RestoreChildCommand, RestoreChildSpec } from './restoreChildRunner.ts';
import {
	assertBackupReadable,
	BackupInProgressError,
	createPreRestoreBackup,
	isRocksDbLockError,
	verifyBackupFiles,
} from './rocksdbBackup.ts';

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

export interface ApplyAndProveArgs {
	/** `staged_tree`: `backupDir` is a staging area whose extracted archive is installed, not engine-restored. */
	sourceKind?: RestoreSourceKind;
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
	expectedTables?: string[];
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
export type RestorePhase = 'verify' | 'probe' | 'apply' | 'prove';

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

export async function applyAndProve(args: ApplyAndProveArgs): Promise<RestoreEvidence> {
	if (args.sourceKind === 'staged_tree') return applyStagedTreeAndProve(args);
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
		await backups.restore(args.backupDir, args.databasePath, { backupId: args.backupId, mode: 'purgeAllFiles' });
		if (args.manifest.blobs) {
			await restoreBlobSnapshot(args.backupDir, args.backupId, args.sourceDatabase, args.blobRoots, {
				durable: true,
			});
		}
		await stampDatabaseDirectory(args.databasePath, { carriesLog: true });
	});
	return inPhase('prove', () => prove(args));
}

async function applyStagedTreeAndProve(args: ApplyAndProveArgs): Promise<RestoreEvidence> {
	const { verifyStagedTree, assertInstallFits, installStagedTree } = await import('./stagedTreeInstall.ts');
	const installBlobs = args.manifest.blobs;
	const operationTag = args.operationId ?? String(process.pid);
	await inPhase('verify', async () => {
		const plan = await verifyStagedTree(args.backupDir);
		await assertInstallFits(args.backupDir, plan, args.databasePath, args.blobRoots, installBlobs, operationTag);
	});
	if (args.probe) await inPhase('probe', () => probeEngineLock(args.databaseName, args.databasePath));
	await inPhase('apply', async () => {
		await announceDestruction();
		await installStagedTree(args.backupDir, args.databasePath, args.blobRoots, installBlobs, operationTag);
		await stampDatabaseDirectory(args.databasePath, { carriesLog: true });
	});
	return inPhase('prove', () => prove(args));
}

async function prove(args: ApplyAndProveArgs): Promise<RestoreEvidence> {
	const generation = openRestoredGeneration(args.databasePath, args.databaseName);
	let evidence: RestoreEvidence;
	try {
		const missingTables = (args.expectedTables ?? []).filter((table) => !generation.tables[table]);
		for (const table of generation.requiredStores.keys()) {
			if (!generation.tables[table]) missingTables.push(table);
		}
		if (missingTables.length > 0) {
			throw new Error(
				`The restored ${args.databaseName} database did not load table(s) the backup contains: ${[...new Set(missingTables)].join(', ')}`
			);
		}
		const replay = (await replayLogs(generation.rootStore, generation.tables, { policy: 'restore' })) as ReplaySummary;
		let blobs: RestoreEvidence['blobs'];
		if (args.acceptUnverifiedBlobs) {
			blobs = {
				blob_integrity: 'unverified',
				waived: true,
				recordsScanned: {},
				references: 0,
				markers: 0,
				failures: [],
			};
		} else {
			const { blobIntegrity, ...assessment } = await assessBlobReferences(generation.tables);
			if (blobIntegrity === 'failed') {
				throw new ClientError(
					`The restored ${args.databaseName} database references blob files the backup does not contain (${assessment.failures
						.map((failure) => `${failure.table} ${JSON.stringify(failure.id)}: ${failure.state}`)
						.join('; ')}); rerun with accept_unverified_blobs=true to publish it anyway`,
					409
				);
			}
			blobs = { blob_integrity: blobIntegrity, ...assessment };
		}
		await (generation.rootStore as any).flush?.();
		evidence = {
			tables: Object.keys(generation.tables),
			required_stores: Object.fromEntries(generation.requiredStores),
			replay,
			blobs,
			durability: process.platform === 'win32' ? 'no-directory-fsync' : 'full',
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
		case 'stage-archive': {
			const { stageArchive } = await import('./archiveStaging.ts');
			return stageArchive(args);
		}
		case 'pre-restore-backup':
			return {
				backupId: await createPreRestoreBackup(args.databaseName, args.databasePath, args.backupDir, args.operationId),
			};
		default:
			throw new Error(`Unknown restore child command ${command}`);
	}
}
