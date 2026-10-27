import { loadRuntimeModule } from '../utility/packageUtils.js';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { RocksDatabase, validateTransactionLogStore } from '@harperfast/rocksdb-js';
import { ClientError } from '../utility/errors/hdbError.ts';
import { fsyncDirectory } from '../utility/durableFile.ts';
import { safeFetchToFile } from '../utility/safeFetch.ts';
import { openRestoredGeneration, closeRestoredGeneration } from '../resources/databases.ts';
import { DiskLedger, ledgerMeter } from './diskLedger.ts';
import { extractArchive, tallyArchive } from './archiveExtraction.ts';
import { withBackupRepositoryLock } from './backupRepository.ts';
import { blobSnapshotDir, copyTree, fsyncTree } from './blobBackup.ts';
import { writeBackupManifest, type BackupManifest } from './backupManifest.ts';
import { resolveServerPath } from './restoreArchive.ts';
import type { FileIdentity } from '../utility/fileIdentity.ts';
import { verifyBackupFiles } from './rocksdbBackup.ts';

const FETCH_TOTAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const FETCH_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const PULL_CHARGE_BATCH_BYTES = 8 * 1024 * 1024;

export interface StageArchiveArgs {
	databaseName: string;
	stagingDir: string;
	serverPath?: string;
	serverPathIdentity?: FileIdentity;
	url?: string;
	s3?: { bucket: string; key: string; region?: string; credentials?: { accessKeyId: string; secretAccessKey: string } };
	sha256?: string;
	acceptIncompatible: boolean;
	restoredFrom: string;
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}

function withTimeout<T>(ms: number, message: string, promise: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout;
	const timedOut = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ClientError(message, 504)), ms);
	});
	return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

async function fetchFromS3(
	s3: NonNullable<StageArchiveArgs['s3']>,
	destination: string,
	ledger: DiskLedger
): Promise<void> {
	if (!s3.credentials) throw new ClientError(`'s3' needs credentials: { secret: '<name>' }`);
	const { getFileStreamFromS3 } = loadRuntimeModule('utility/AWS/AWSConnector');
	const body = await withTimeout<NodeJS.ReadableStream>(
		FETCH_IDLE_TIMEOUT_MS,
		`S3 did not answer for ${s3.bucket}/${s3.key}`,
		getFileStreamFromS3({
			s3: {
				bucket: s3.bucket,
				key: s3.key,
				region: s3.region,
				aws_access_key_id: s3.credentials.accessKeyId,
				aws_secret_access_key: s3.credentials.secretAccessKey,
			},
		})
	);
	await pipeline(
		body,
		ledgerMeter(ledger, destination, { idleMs: FETCH_IDLE_TIMEOUT_MS }),
		createWriteStream(destination, { flags: 'wx' })
	);
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
	if (failures.length > 0) throw new AggregateError(failures, 'The archived database did not close cleanly');
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

/** The private repository a staged archive becomes: one backup, seen by nothing but its own restore. */
export function stagedRepositoryDir(stagingDir: string): string {
	return join(stagingDir, 'repo');
}

/**
 * Brings the archive onto disk, tallies it, reserves the peak it needs, extracts it under the entry
 * filter, proves its logs and catalogue, and converts it into a one-backup repository inside its own
 * staging area — never the database's repository — verified, with the completion manifest written
 * last. A restore then publishes from that repository exactly as from any other.
 */
export async function stageArchive(args: StageArchiveArgs) {
	const { databaseName, stagingDir } = args;
	const stagingRoot = join(stagingDir, '..');
	mkdirSync(stagingRoot, { recursive: true });
	fsyncDirectory(join(stagingRoot, '..'));
	mkdirSync(stagingDir, { recursive: true });
	fsyncDirectory(stagingRoot);
	const repoDir = stagedRepositoryDir(stagingDir);
	const ledger = new DiskLedger();
	let archivePath: string;
	if (args.serverPath !== undefined) {
		archivePath = resolveServerPath(args.serverPath, args.serverPathIdentity!);
	} else {
		archivePath = join(stagingDir, 'archive');
		if (args.url !== undefined) {
			// bounded by what the staging device can take, so a pull cannot fill the databases' device, and
			// charged as it lands, since the room sampled at the start goes stale over a long transfer
			const { bytes: room } = await ledger.remaining(stagingDir);
			const refused = new AbortController();
			let uncharged = 0;
			let charging = Promise.resolve();
			const charge = (bytes: number) => {
				charging = charging.then(() => ledger.debit(stagingDir, bytes)).catch((error) => refused.abort(error));
			};
			await safeFetchToFile(args.url, archivePath, {
				totalTimeoutMs: FETCH_TOTAL_TIMEOUT_MS,
				idleTimeoutMs: FETCH_IDLE_TIMEOUT_MS,
				maxBytes: Math.max(0, room),
				sha256: args.sha256,
				signal: refused.signal,
				onBytes(bytes) {
					uncharged += bytes;
					if (uncharged < PULL_CHARGE_BATCH_BYTES) return;
					charge(uncharged);
					uncharged = 0;
				},
			});
			if (uncharged > 0) charge(uncharged);
			await charging;
			if (refused.signal.aborted) throw refused.signal.reason;
		} else if (args.s3 !== undefined) {
			await fetchFromS3(args.s3, archivePath, ledger);
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
	// Before the first byte is written: extraction debits the staging device as it goes, and the engine
	// copy and blob snapshot need as much again beside the tree.
	const conversionHold = await ledger.reserve(stagingDir, tally.bytes, tally.inodes);
	let extracted: Awaited<ReturnType<typeof extractArchive>>;
	try {
		mkdirSync(treeDir);
		extracted = await extractArchive(archivePath, treeDir, {
			ledger,
			allowMissingManifest: args.acceptIncompatible,
			acceptIncompatible: args.acceptIncompatible,
		});
		if (args.serverPath === undefined) rmSync(archivePath, { force: true });
		await validateTransactionLogs(treeDir);
		const tables = provenTables(treeDir, databaseName);
		const blobIndices = archiveBlobRootIndices(treeDir);
		const hasBlobs = extracted.manifest ? extracted.manifest.blobs : blobIndices.length > 0;
		const backupId = await withBackupRepositoryLock(
			repoDir,
			databaseName,
			async () => {
				// a destructive restore will depend on this repository surviving a power loss
				fsyncDirectory(stagingDir);
				const database = RocksDatabase.open(treeDir);
				let id: number;
				try {
					id = await database.backup(repoDir, { transactionLogs: true });
				} finally {
					database.close();
				}
				if (hasBlobs) await snapshotArchiveBlobs(treeDir, repoDir, id, blobIndices);
				const candidate: BackupManifest = { backupId: id, blobs: hasBlobs, completedAt: Date.now() };
				await verifyBackupFiles(repoDir, id, candidate, databaseName, false, true);
				fsyncDirectory(repoDir);
				await writeBackupManifest(repoDir, id, hasBlobs, extracted.manifest ?? undefined, {
					tables,
					imported_from: args.restoredFrom,
					digest,
				});
				return id;
			},
			true
		);
		return {
			backupDir: repoDir,
			backupId,
			tables,
			identified: extracted.manifest !== null,
			...(extracted.waived.length > 0 ? { compatibility_waived: extracted.waived } : {}),
			digest,
			restored_from: args.restoredFrom,
			blobs: hasBlobs,
			bytes: extracted.bytes,
			roles: extracted.manifest?.roles ?? [],
		};
	} finally {
		conversionHold.release(0);
		rmSync(treeDir, { recursive: true, force: true });
	}
}
