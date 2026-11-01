import { loadRuntimeModule } from '../utility/packageUtils.js';
import { createHash } from 'node:crypto';
import {
	closeSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	openSync,
	readFileSync,
	rmSync,
	statfsSync,
	statSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { validateTransactionLogStore } from '@harperfast/rocksdb-js';
import { ClientError } from '../utility/errors/hdbError.ts';
import { fsyncDirectory, writeFileDurably } from '../utility/durableFile.ts';
import { fsyncTolerantSync } from '../utility/fsync.ts';
import { safeFetchToFile } from '../utility/safeFetch.ts';
import { openRestoredGeneration, closeRestoredGeneration } from '../resources/databases.ts';
import { allocationUnit, DiskLedger, ledgerMeter } from './diskLedger.ts';
import { extractArchive, tallyArchive } from './archiveExtraction.ts';
import { fsyncTree } from './blobBackup.ts';
import type { BackupManifest } from './backupManifest.ts';
import { ARCHIVE_MANIFEST_ENTRY } from './backupArchiveManifest.ts';
import { resolveServerPath } from './restoreArchive.ts';
import type { FileIdentity } from '../utility/fileIdentity.ts';

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

/** A tar or gzip decoding failure means the file is not an archive at all; disk and policy errors pass through. */
function notAnArchive(error: any, restoredFrom: string): unknown {
	if (error instanceof ClientError || (error?.code && !String(error.code).startsWith('Z_'))) return error;
	return new ClientError(`${restoredFrom} is not a get_backup archive (a .tar or .tar.gz): ${error?.message ?? error}`);
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

/**
 * The tables the archive's catalogue loads, proving every column family it requires is present, and
 * every record and index entry read once: RocksDB checks each block's checksum as it reads it, the only
 * whole-database verification an extracted tree (which carries no backup checksums) can have.
 */
function provenTables(treeDir: string, databaseName: string): string[] {
	const generation = openRestoredGeneration(treeDir, databaseName);
	let tables: string[];
	try {
		tables = Object.keys(generation.tables);
		for (const table of Object.values(generation.tables) as any[]) {
			for (const _entry of table.primaryStore.getRange({ versions: true })) {
				// reading is the check
			}
			for (const index of Object.values(table.indices ?? {}) as any[]) {
				for (const _entry of index.getRange({})) {
					// reading is the check
				}
			}
		}
	} catch (error) {
		closeRestoredGeneration(treeDir, generation);
		throw error;
	}
	const failures = closeRestoredGeneration(treeDir, generation);
	if (failures.length > 0) throw new AggregateError(failures, 'The archived database did not close cleanly');
	return tables;
}

/** A staged archive is one source, so it always presents as backup 1 of its staging area. */
export const STAGED_TREE_BACKUP_ID = 1;
const STAGED_SOURCE_FILE = 'staged.json';
export const STAGED_INVENTORY_FILE = 'inventory.ndjson';

export function stagedTreeDir(stagingDir: string): string {
	return join(stagingDir, 'tree');
}

/** What the restore needs to know about a staged archive, read by the parent without the inventory. */
export interface StagedSource {
	manifest: BackupManifest;
	waived: string[];
	blobIndices: number[];
}

export function readStagedSource(stagingDir: string): StagedSource {
	let parsed: any;
	try {
		parsed = JSON.parse(readFileSync(join(stagingDir, STAGED_SOURCE_FILE), 'utf8'));
	} catch (error: any) {
		throw new ClientError(
			`The staged archive at ${stagingDir} is not complete (${error?.code ?? error?.message})`,
			410
		);
	}
	return parsed as StagedSource;
}

/** Files RocksDB rewrites on its own or that only describe a past open; a restore does not carry them. */
const UNINSTALLED_FILE = /^(LOCK|LOG|LOG\.old\..*)$/;

export interface InventoryFile {
	path: string;
	size: number;
	sha256: string;
}

/** One JSON entry per line, written and read as a stream, so no heap ever holds the whole tree's list. */
async function writeInventory(treeDir: string, inventoryPath: string): Promise<void> {
	const out = createWriteStream(inventoryPath, { flags: 'w' });
	const write = (line: string) =>
		new Promise<void>((resolve, reject) => out.write(line, (error) => (error ? reject(error) : resolve())));
	const visit = async (directory: string, prefix: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path, relativePath);
			else if (entry.isFile()) {
				if (!prefix && (UNINSTALLED_FILE.test(entry.name) || entry.name === ARCHIVE_MANIFEST_ENTRY)) {
					rmSync(path, { force: true });
					continue;
				}
				const file: InventoryFile = { path: relativePath, size: statSync(path).size, sha256: await sha256File(path) };
				await write(JSON.stringify(file) + '\n');
			}
		}
	};
	try {
		await visit(treeDir, '');
	} finally {
		await new Promise<void>((resolve, reject) => out.end((error?: Error) => (error ? reject(error) : resolve())));
	}
	const fd = openSync(inventoryPath, 'r');
	try {
		fsyncTolerantSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * The extracted tree is the restore's source, so it must be proven readable and inventoried before any
 * target is touched; see dataLayer/DESIGN.md.
 */
export async function stageArchive(args: StageArchiveArgs) {
	const { databaseName, stagingDir } = args;
	// every new level durable, up to the backups root: a receipt will name this area as its only source
	const stagingRoot = join(stagingDir, '..');
	const databaseBackupDir = join(stagingRoot, '..');
	mkdirSync(stagingDir, { recursive: true });
	fsyncDirectory(join(databaseBackupDir, '..'));
	fsyncDirectory(databaseBackupDir);
	fsyncDirectory(stagingRoot);
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
			if (room <= 0) {
				throw new ClientError(`Insufficient storage on the volume holding ${stagingDir} to download the archive`, 507);
			}
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
	const tally = await tallyArchive(archivePath, { bsize: allocationUnit(statfsSync(stagingDir).bsize) }).catch(
		(error) => {
			throw notAnArchive(error, args.restoredFrom);
		}
	);
	// refuse an archive the staging device cannot hold before writing any of it; extraction then debits
	// the same bytes as it lands
	(await ledger.reserve(stagingDir, tally.bytes, tally.inodes)).release(0, 0);
	mkdirSync(treeDir);
	{
		const extracted = await extractArchive(archivePath, treeDir, {
			ledger,
			allowMissingManifest: args.acceptIncompatible,
			acceptIncompatible: args.acceptIncompatible,
		}).catch((error) => {
			throw notAnArchive(error, args.restoredFrom);
		});
		if (args.serverPath === undefined) rmSync(archivePath, { force: true });
		await validateTransactionLogs(treeDir);
		if (!existsSync(join(treeDir, 'CURRENT'))) {
			throw new ClientError(
				`${args.restoredFrom} is an archive but holds no Harper database backup (it has no RocksDB CURRENT file)`
			);
		}
		const tables = provenTables(treeDir, databaseName);
		const blobIndices = archiveBlobRootIndices(treeDir);
		const hasBlobs = extracted.manifest ? extracted.manifest.blobs : blobIndices.length > 0;
		// read after the scan: opening the tree rewrites its MANIFEST and OPTIONS
		await writeInventory(treeDir, join(stagingDir, STAGED_INVENTORY_FILE));
		await fsyncTree(treeDir);
		const manifest: BackupManifest = {
			backupId: STAGED_TREE_BACKUP_ID,
			blobs: hasBlobs,
			completedAt: Date.now(),
			tables,
		};
		const staged: StagedSource = { manifest, waived: extracted.waived, blobIndices };
		// written last: its presence is what makes the staging area a restorable source
		writeFileDurably(join(stagingDir, STAGED_SOURCE_FILE), JSON.stringify(staged), `${STAGED_SOURCE_FILE}.tmp`);
		fsyncDirectory(stagingDir);
		return {
			backupDir: stagingDir,
			backupId: STAGED_TREE_BACKUP_ID,
			tables,
			identified: extracted.manifest !== null,
			...(extracted.waived.length > 0 ? { compatibility_waived: extracted.waived } : {}),
			digest,
			restored_from: args.restoredFrom,
			blobs: hasBlobs,
			bytes: extracted.bytes,
			roles: extracted.manifest?.roles ?? [],
		};
	}
}
