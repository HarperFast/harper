import { closeSync, existsSync, fsyncSync, openSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { chmod, readdir, stat } from 'node:fs/promises';
import { RocksDatabase, backups, getRegistryStatus, validateTransactionLogStore } from '@harperfast/rocksdb-js';
import { initSync, setProperty } from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { isUnsupportedSyncError } from '../utility/fsync.ts';
import { getDatabaseGeneration, stampDatabaseDirectory } from '../resources/auditStore.ts';
import {
	openRestoredGeneration,
	closeRestoredGeneration,
	openRocksDatabase,
	type RestoredGeneration,
} from '../resources/databases.ts';
import { replayLogs, type ReplaySummary } from '../resources/replayLogs.ts';
import { assessBlobReferences, databasePaths, type BlobReferenceAssessment } from '../resources/blob.ts';
import { fsyncTree, restoreBlobSnapshot } from './blobBackup.ts';
import type { StagedRecord } from './archiveStaging.ts';
import type { BackupManifest } from './backupManifest.ts';
import { readRestoreReceipt } from './restoreReceipt.ts';
import { RESTORE_META_DIR } from './restoreMarker.ts';
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

interface ApplyAndProveArgs {
	operationId?: string;
	databaseName: string;
	sourceDatabase: string;
	databasePath: string;
	backupDir: string;
	backupId?: number;
	manifest?: BackupManifest;
	/** `staged_tree`: install the proven staged archive in `stagingDir` instead of restoring a backup. */
	sourceKind?: 'staged_tree';
	stagingDir?: string;
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
	/** A staged proof's stores read to their end, beyond the primary stores the blob assessment reads. */
	stores_read?: string[];
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
	if (args.sourceKind === 'staged_tree') return applyStagedAndProve(args);
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
		const roots = args.manifest!.blobs ? [args.databasePath, ...args.blobRoots] : [args.databasePath];
		// a copy keeps its source's mode, so a read-only repository (`immutable_source`) yields read-only
		// transaction logs and blobs: before the purge, so debris an earlier attempt left can be removed,
		// and after the copy, so the new generation is one this database can write
		for (const root of roots) await makeOwnerWritable(root);
		await backups.restore(args.backupDir, args.databasePath, { backupId: args.backupId, mode: 'purgeAllFiles' });
		if (args.manifest!.blobs) {
			await restoreBlobSnapshot(args.backupDir, args.backupId!, args.sourceDatabase, args.blobRoots, {
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

/** What a failed proof calls the database: a staged archive is proven before it replaces anything. */
function provenDatabase(databaseName: string, staged = false): string {
	return `The ${staged ? 'extracted' : 'restored'} ${databaseName} database`;
}

function assertTablesLoaded(generation: RestoredGeneration, database: string, source: 'archive' | 'backup'): void {
	const missingTables = [...generation.requiredStores.keys()].filter((table) => !generation.tables[table]);
	if (missingTables.length > 0) {
		throw new Error(`${database} did not load table(s) the ${source} contains: ${missingTables.join(', ')}`);
	}
}

interface ProveOptions {
	/** Resolve blob references here instead of the configured roots: a staged proof never touches the live ones. */
	blobRoots?: string[];
	/** Read every store to its end, not only the primary stores the blob assessment reads. */
	scanEveryStore?: boolean;
}

async function prove(args: ApplyAndProveArgs, options: ProveOptions = {}): Promise<RestoreEvidence> {
	const generation = openRestoredGeneration(args.databasePath, args.databaseName);
	if (options.blobRoots) databasePaths.set(generation.rootStore as any, options.blobRoots);
	const staged = options.blobRoots !== undefined;
	let evidence: RestoreEvidence;
	try {
		assertTablesLoaded(generation, provenDatabase(args.databaseName, staged), staged ? 'archive' : 'backup');
		const replay = (await replayLogs(generation.rootStore, generation.tables, { policy: 'restore' })) as ReplaySummary;
		// the scan is also the strict read of every record, so the waiver relaxes only the blob verdict
		const { blobIntegrity, ...assessment } = await assessBlobReferences(generation.tables);
		if (blobIntegrity === 'failed' && !args.acceptUnverifiedBlobs) {
			throw new ClientError(
				`${provenDatabase(args.databaseName, staged)} references blob files the ${staged ? 'archive' : 'backup'} does not contain (${assessment.failures
					.map((failure) => `${failure.table} ${JSON.stringify(failure.id)}: ${failure.state}`)
					.join('; ')}); rerun with accept_unverified_blobs=true to ${staged ? 'restore' : 'publish'} it anyway`,
				409
			);
		}
		const blobs: RestoreEvidence['blobs'] =
			blobIntegrity === 'failed'
				? { blob_integrity: 'unverified', waived: true, ...assessment }
				: { blob_integrity: blobIntegrity, ...assessment };
		const storesRead = options.scanEveryStore ? scanRemainingStores(args, generation, staged) : undefined;
		await (generation.rootStore as any).flush?.();
		evidence = {
			tables: Object.keys(generation.tables),
			required_stores: Object.fromEntries(generation.requiredStores),
			replay,
			blobs,
			durability: directoryFsyncSupported(args.databasePath) ? 'full' : 'no-directory-fsync',
			...(storesRead ? { stores_read: storesRead } : {}),
		};
	} catch (error) {
		closeRestoredGeneration(args.databasePath, generation);
		throw error;
	}
	const closeFailures = closeRestoredGeneration(args.databasePath, generation);
	if (closeFailures.length > 0) {
		throw new AggregateError(closeFailures, `${provenDatabase(args.databaseName, staged)} did not close cleanly`);
	}
	return evidence;
}

/**
 * The blob assessment reads only each table's primary store, so the index, catalogue and default
 * stores are read here, to their end: RocksDB checks each block's checksum as it reads it. A column
 * family no opened store covers — a table's leftover, say — is opened by name and read the same way.
 */
function scanRemainingStores(args: ApplyAndProveArgs, generation: RestoredGeneration, staged: boolean): string[] {
	const scanned = new Set<unknown>(Object.values(generation.tables).map((table: any) => table.primaryStore));
	const covered = new Set<string>();
	const read: string[] = [];
	const readToEnd = (store: any, name: string) => {
		try {
			for (const _key of store.getRange({ values: false, snapshot: false }));
		} catch (error) {
			throw new Error(`${provenDatabase(args.databaseName, staged)} could not read its store '${name}'`, {
				cause: error,
			});
		}
	};
	for (const store of [generation.rootStore, ...generation.openedStores] as any[]) {
		covered.add(store.name);
		if (scanned.has(store)) continue;
		scanned.add(store);
		readToEnd(store, store.name);
		read.push(store.name);
	}
	const path = resolve(args.databasePath);
	const uncovered = new Set(
		getRegistryStatus()
			.filter((instance) => resolve(instance.path) === path)
			.flatMap((instance) => Object.keys(instance.columnFamilies ?? {}))
			.filter((family) => !covered.has(family))
	);
	for (const family of uncovered) {
		let store: any;
		try {
			// keys as raw bytes: what the family holds is not known to any table here
			store = openRocksDatabase(args.databasePath, { name: family, keyEncoding: 'binary', disableWAL: false } as any);
		} catch (error) {
			throw new Error(`${provenDatabase(args.databaseName, staged)} could not open its store '${family}'`, {
				cause: error,
			});
		}
		let readError: unknown;
		try {
			readToEnd(store, family);
			read.push(family);
		} catch (error) {
			readError = error;
		}
		try {
			store.close();
		} catch (error) {
			// a damaged family can fail its close as well; the read is what names the damage
			readError ??= new Error(`${provenDatabase(args.databaseName, staged)} could not close its store '${family}'`, {
				cause: error,
			});
		}
		if (readError) throw readError;
	}
	return read;
}

/** Every transaction log the archive carries must be whole: a backup snapshot is clean end to end. */
async function validateTransactionLogs(databasePath: string): Promise<void> {
	const logsDir = join(databasePath, 'transaction_logs');
	if (!existsSync(logsDir)) return;
	for (const entry of await readdir(logsDir, { withFileTypes: true })) {
		// dot-entries are the binding's own bookkeeping, not log stores
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const result: any = await validateTransactionLogStore(join(logsDir, entry.name), { strict: true });
		if (!result.valid) {
			const errors = [...(result.errors ?? []), ...(result.files ?? []).flatMap((file: any) => file.errors ?? [])];
			throw new ClientError(
				`The archive's transaction log '${entry.name}' is not valid: ${errors.join('; ') || 'invalid framing'}`
			);
		}
	}
}

function reservedDirectoryParent(path: string): string {
	let ancestor = path;
	while (basename(ancestor) !== RESTORE_META_DIR && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
	return dirname(ancestor);
}

interface ProveStagedArgs {
	stagingDir: string;
	databaseName: string;
	acceptUnverifiedBlobs?: boolean;
}

/**
 * Proves a staged archive where it sits, with the target still serving: the restore proof, run against
 * the staged parts and never the live roots, and then every store read to its end. What it proved is
 * recorded in `staged.json`, which a later swap checks before it destroys anything.
 */
async function proveStaged(args: ProveStagedArgs): Promise<Pick<StagedRecord, 'generation' | 'evidence'>> {
	const { readStagedRecord, writeStagedRecord, withIdentities } = await import('./archiveStaging.ts');
	const record = readStagedRecord(args.stagingDir, args.databaseName);
	if (record.state === 'proven') return { generation: record.generation, evidence: record.evidence };
	const databasePath = record.parts[0].staged;
	if (!existsSync(join(databasePath, 'CURRENT'))) {
		throw new ClientError('The archive holds no Harper database (it has no RocksDB CURRENT file)');
	}
	await validateTransactionLogs(databasePath);
	const generation = await stampDatabaseDirectory(databasePath, { carriesLog: true });
	const blobRoots = record.parts
		.filter((part) => part.kind === 'blobs')
		.sort((a, b) => a.index! - b.index!)
		.map((part) => part.staged);
	const evidence = await prove(
		{
			databaseName: args.databaseName,
			sourceDatabase: args.databaseName,
			databasePath,
			backupDir: '',
			blobRoots,
			probe: false,
			interrupted: false,
			acceptUnverifiedBlobs: args.acceptUnverifiedBlobs,
		},
		{ blobRoots, scanEveryStore: true }
	);
	for (const part of record.parts) {
		// through the reserved directory's parent, whose entry for it may be as new as this restore
		const through = reservedDirectoryParent(part.staged);
		await fsyncTree(part.staged, through);
		await fsyncTree(dirname(part.previous), through);
	}
	const proven: StagedRecord = {
		...record,
		state: 'proven',
		parts: withIdentities(record.parts),
		generation,
		evidence: evidence as unknown as Record<string, unknown>,
		proven_at: Date.now(),
	};
	writeStagedRecord(args.stagingDir, proven);
	return { generation, evidence: proven.evidence };
}

/**
 * The staged branch of apply-and-prove: verify that the proven parts are still staged or already
 * installed and still belong where configuration puts them, rename each into place, then check that
 * what opens at the destination is the generation the staged proof stamped.
 */
async function applyStagedAndProve(args: ApplyAndProveArgs): Promise<RestoreEvidence> {
	const { readStagedRecord, verifyStagedSwap, applyStagedSwap } = await import('./archiveStaging.ts');
	const record = await inPhase('verify', async () => {
		const read = readStagedRecord(args.stagingDir!, args.databaseName);
		verifyStagedSwap(read, args.databasePath, args.blobRoots);
		return read;
	});
	if (args.probe) await inPhase('probe', () => probeEngineLock(args.databaseName, args.databasePath));
	await inPhase('apply', async () => {
		await announceDestruction();
		applyStagedSwap(record);
	});
	return inPhase('prove', async () => {
		const generation = openRestoredGeneration(args.databasePath, args.databaseName);
		try {
			assertTablesLoaded(generation, provenDatabase(args.databaseName), 'archive');
			const opened = getDatabaseGeneration((generation.rootStore as any).auditStore);
			if (!opened || opened.id !== record.generation?.id) {
				throw new Error(
					`The installed ${args.databaseName} database is not the generation the staged proof stamped (${opened?.id ?? 'none'}, expected ${record.generation?.id})`
				);
			}
		} catch (error) {
			closeRestoredGeneration(args.databasePath, generation);
			throw error;
		}
		const failures = closeRestoredGeneration(args.databasePath, generation);
		if (failures.length > 0) {
			throw new AggregateError(failures, `The restored ${args.databaseName} database did not close cleanly`);
		}
		return {
			...(record.evidence as unknown as RestoreEvidence),
			durability: directoryFsyncSupported(args.databasePath) ? 'full' : 'no-directory-fsync',
		};
	});
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
		case 'prove-staged':
			return proveStaged(args);
		case 'pre-restore-backup':
			return {
				backupId: await createPreRestoreBackup(args.databaseName, args.databasePath, args.backupDir, args.operationId),
			};
		default:
			throw new Error(`Unknown restore child command ${command}`);
	}
}
