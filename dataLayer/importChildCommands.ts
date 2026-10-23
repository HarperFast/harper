import { createHash } from 'node:crypto';
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	statfsSync,
} from 'node:fs';
import { rename } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { RocksDatabase, backups, validateTransactionLogStore } from '@harperfast/rocksdb-js';
import { ClientError } from '../utility/errors/hdbError.ts';
import { fsyncDirectory } from '../utility/durableFile.ts';
import { safeFetchToFile } from '../utility/safeFetch.ts';
import { openRestoredGeneration, closeRestoredGeneration } from '../resources/databases.ts';
import { DiskLedger } from './diskLedger.ts';
import { extractArchive, tallyArchive } from './archiveExtraction.ts';
import { withBackupRepositoryLock } from './backupRepository.ts';
import { blobSnapshotDir, copyTree, deleteBlobSnapshot, fsyncTree } from './blobBackup.ts';
import { deleteBackupManifest, writeBackupManifest, type BackupManifest } from './backupManifest.ts';
import { IMPORT_SOURCE_DIR } from './backupImport.ts';
import { verifyBackupFiles } from './rocksdbBackup.ts';

const FETCH_TOTAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const FETCH_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export interface ImportArchiveArgs {
	databaseName: string;
	backupDir: string;
	importId: string;
	stagingDir: string;
	sourceFile?: string;
	url?: string;
	s3?: { bucket: string; key: string; region?: string; credentials?: { accessKeyId: string; secretAccessKey: string } };
	sha256?: string;
	acceptIncompatible: boolean;
	importedFrom: string;
}

/** The archive under `.import/`, refusing any name that resolves outside it, links included. */
function resolveSourceFile(backupDir: string, sourceFile: string): string {
	const importRoot = join(backupDir, IMPORT_SOURCE_DIR);
	if (!existsSync(importRoot)) throw new ClientError(`${importRoot} does not exist`, 404);
	const root = realpathSync(importRoot);
	let resolved: string;
	try {
		resolved = realpathSync(join(importRoot, sourceFile));
	} catch {
		throw new ClientError(`No archive named '${sourceFile}' in ${importRoot}`, 404);
	}
	if (!resolved.startsWith(root + sep) || !statSync(resolved).isFile()) {
		throw new ClientError(`'${sourceFile}' is not a file inside ${importRoot}`);
	}
	return resolved;
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}

async function fetchFromS3(s3: NonNullable<ImportArchiveArgs['s3']>, destination: string): Promise<void> {
	if (!s3.credentials) throw new ClientError(`'s3' needs credentials: { secret: '<name>' }`);
	const { getFileStreamFromS3 } = require('../utility/AWS/AWSConnector.js');
	const body = await getFileStreamFromS3({
		s3: {
			bucket: s3.bucket,
			key: s3.key,
			region: s3.region,
			aws_access_key_id: s3.credentials.accessKeyId,
			aws_secret_access_key: s3.credentials.secretAccessKey,
		},
	});
	await pipeline(body, createWriteStream(destination, { flags: 'wx' }));
}

/** Archive blob roots by their recorded index; a gap must stay a gap, or blobs would be mis-addressed. */
function archiveBlobRootIndices(treeDir: string): number[] {
	const blobsDir = join(treeDir, 'blobs');
	if (!existsSync(blobsDir)) return [];
	return readdirSync(blobsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
		.map((entry) => Number(entry.name))
		.sort((a, b) => a - b);
}

async function validateTransactionLogs(treeDir: string): Promise<void> {
	const logsDir = join(treeDir, 'transaction_logs');
	if (!existsSync(logsDir)) return;
	for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const result: any = await validateTransactionLogStore(join(logsDir, entry.name), { strict: true });
		if (!result.valid) {
			throw new ClientError(
				`The archive's transaction log '${entry.name}' is not valid: ${(result.errors ?? []).join('; ') || 'invalid framing'}`
			);
		}
	}
}

/** The tables the archive's catalogue loads, proving every column family it requires is present. */
function provenTables(treeDir: string, databaseName: string): string[] {
	const generation = openRestoredGeneration(treeDir, databaseName);
	const tables = Object.keys(generation.tables);
	const failures = closeRestoredGeneration(treeDir, generation);
	if (failures.length > 0) throw new AggregateError(failures, 'The imported database did not close cleanly');
	return tables;
}

async function snapshotArchiveBlobs(treeDir: string, backupDir: string, backupId: number, indices: number[]) {
	const snapshotDir = blobSnapshotDir(backupDir, backupId);
	const tempDir = snapshotDir + '.tmp';
	rmSync(tempDir, { recursive: true, force: true });
	mkdirSync(tempDir, { recursive: true });
	for (const index of indices) {
		await copyTree(join(treeDir, 'blobs', String(index)), join(tempDir, String(index)), true);
	}
	await fsyncTree(tempDir);
	rmSync(snapshotDir, { recursive: true, force: true });
	await rename(tempDir, snapshotDir);
	fsyncDirectory(join(snapshotDir, '..'));
}

/**
 * Brings the archive onto disk, tallies it, reserves the peak it needs, extracts it under the entry
 * filter, proves its logs and catalogue, converts it into the repository, verifies the result with
 * the manifest still in memory, and publishes the completion manifest last — so a failure at any step
 * leaves nothing `list_backups` would show.
 */
export async function importArchive(args: ImportArchiveArgs) {
	const { databaseName, backupDir, stagingDir } = args;
	mkdirSync(stagingDir, { recursive: true });
	const ledger = new DiskLedger();
	let archivePath: string;
	if (args.sourceFile !== undefined) {
		archivePath = resolveSourceFile(backupDir, args.sourceFile);
	} else {
		archivePath = join(stagingDir, 'archive');
		if (args.url !== undefined) {
			await safeFetchToFile(args.url, archivePath, {
				totalTimeoutMs: FETCH_TOTAL_TIMEOUT_MS,
				idleTimeoutMs: FETCH_IDLE_TIMEOUT_MS,
			});
		} else if (args.s3 !== undefined) {
			await fetchFromS3(args.s3, archivePath);
		} else if (!existsSync(archivePath)) {
			throw new ClientError('The uploaded archive is no longer staged; upload it again', 410);
		}
	}
	const digest = await sha256File(archivePath);
	if (args.sha256 && digest !== args.sha256.toLowerCase()) {
		throw new ClientError(`The archive's sha256 is ${digest}, not the ${args.sha256} the request pinned`);
	}

	const treeDir = join(stagingDir, 'tree');
	const tally = await tallyArchive(archivePath, { bsize: statfsSync(stagingDir).bsize });
	// Before the first byte is written: extraction debits its own device as it goes, but the engine copy
	// and the blob snapshot land in the repository, which may be another device.
	const conversionHold = await ledger.reserve(backupDir, tally.bytes, tally.inodes);
	let backupId: number;
	let extracted: Awaited<ReturnType<typeof extractArchive>>;
	try {
		mkdirSync(treeDir);
		extracted = await extractArchive(archivePath, treeDir, {
			ledger,
			allowMissingManifest: args.acceptIncompatible,
			acceptIncompatible: args.acceptIncompatible,
		});
		if (args.sourceFile === undefined) rmSync(archivePath, { force: true });
		await validateTransactionLogs(treeDir);
		const tables = provenTables(treeDir, databaseName);
		const blobIndices = archiveBlobRootIndices(treeDir);
		const hasBlobs = extracted.manifest ? extracted.manifest.blobs : blobIndices.length > 0;
		backupId = await withBackupRepositoryLock(
			backupDir,
			databaseName,
			async () => {
				const database = RocksDatabase.open(treeDir);
				let id: number;
				try {
					id = await database.backup(backupDir, { transactionLogs: true });
				} finally {
					database.close();
				}
				try {
					if (hasBlobs) await snapshotArchiveBlobs(treeDir, backupDir, id, blobIndices);
					const candidate: BackupManifest = { backupId: id, blobs: hasBlobs, completedAt: Date.now() };
					await verifyBackupFiles(backupDir, id, candidate, databaseName, false, true);
					fsyncDirectory(backupDir);
					await writeBackupManifest(backupDir, id, hasBlobs, extracted.manifest ?? undefined, {
						tables,
						imported_from: args.importedFrom,
						digest,
					});
				} catch (error) {
					await deleteBackupManifest(backupDir, id).catch(() => {});
					await deleteBlobSnapshot(backupDir, id).catch(() => {});
					await backups.delete(backupDir, id).catch(() => {});
					throw error;
				}
				return id;
			},
			true
		);
		return {
			database: databaseName,
			backup_id: backupId,
			tables,
			identified: extracted.manifest !== null,
			...(extracted.waived.length > 0 ? { compatibility_waived: extracted.waived } : {}),
			digest,
			imported_from: args.importedFrom,
			blobs: hasBlobs,
			blob_root_count: blobIndices.length,
			bytes: extracted.bytes,
			roles: extracted.manifest?.roles ?? [],
		};
	} finally {
		conversionHold.release(0);
		rmSync(treeDir, { recursive: true, force: true });
	}
}
