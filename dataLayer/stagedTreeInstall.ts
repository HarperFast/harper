/**
 * Installs a staged archive tree into a restore target, in the restore child. The tree stays whole —
 * files that never change (RocksDB table and blob files, Harper blob files) are hard-linked where the
 * filesystem allows, everything else is copied — so a failure at any point leaves the staged source
 * intact for the rerun, which purges the target and installs again. See dataLayer/DESIGN.md.
 */
import { createHash } from 'node:crypto';
import {
	closeSync,
	createReadStream,
	createWriteStream,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ClientError } from '../utility/errors/hdbError.ts';
import { fsyncDirectory } from '../utility/durableFile.ts';
import { fsyncTolerantSync } from '../utility/fsync.ts';
import { copyTree, fsyncTree } from './blobBackup.ts';
import { DiskLedger } from './diskLedger.ts';
import { STAGED_INVENTORY_FILE, stagedTreeDir, type InventoryFile } from './archiveStaging.ts';

const IMMUTABLE_ENGINE_FILE = /^[^/]+\.(sst|blob)$/;
const BLOBS_PREFIX = 'blobs/';
const BLOB_ROOT_FILE = /^blobs\/(\d+)\//;

/** The blob root a staged file belongs to; undefined for anything else under `blobs/` (its README). */
function blobRootIndex(path: string): number | undefined {
	const match = BLOB_ROOT_FILE.exec(path);
	return match ? Number(match[1]) : undefined;
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}

function readInventory(stagingDir: string): InventoryFile[] {
	const { files } = JSON.parse(readFileSync(join(stagingDir, STAGED_INVENTORY_FILE), 'utf8'));
	const seen = new Set<string>();
	for (const file of files as InventoryFile[]) {
		const path = file?.path;
		if (
			typeof path !== 'string' ||
			path === '' ||
			isAbsolute(path) ||
			normalize(path) !== path.split('/').join(sep) ||
			path.split('/').includes('..') ||
			seen.has(path) ||
			!Number.isSafeInteger(file.size) ||
			typeof file.sha256 !== 'string'
		) {
			throw new Error(`The staged inventory in ${stagingDir} has an invalid entry: ${JSON.stringify(file)}`);
		}
		seen.add(path);
	}
	return files;
}

/**
 * Before anything is destroyed: every staged file must still be byte-for-byte what was verified when
 * the archive was staged — a restart restore can wait on its staging for a long time.
 */
export async function verifyStagedTree(stagingDir: string): Promise<InventoryFile[]> {
	const files = readInventory(stagingDir);
	const treeDir = stagedTreeDir(stagingDir);
	for (const file of files) {
		const path = join(treeDir, file.path);
		let size: number;
		try {
			size = statSync(path).size;
		} catch {
			throw new ClientError(`The staged archive is missing ${file.path}; restore from the archive again`, 410);
		}
		if (size !== file.size || (await sha256File(path)) !== file.sha256) {
			throw new ClientError(
				`The staged archive's ${file.path} changed after it was verified; restore from the archive again`,
				409
			);
		}
	}
	return files;
}

function deviceOf(path: string): number {
	let existing = path;
	while (!existsSync(existing)) existing = dirname(existing);
	return statSync(existing).dev;
}

/** Bytes an existing tree gives back when it is purged: only files no other link keeps alive. */
function reclaimableBytes(root: string): number {
	if (!existsSync(root)) return 0;
	let bytes = 0;
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) {
				const stats = statSync(path);
				if (stats.nlink === 1) bytes += stats.blocks * 512;
			}
		}
	};
	visit(root);
	return bytes;
}

/**
 * Refuses, before destruction, an install a destination device cannot hold: the bytes that must be
 * copied there (linking is free on the staging device) against what it has, crediting only what the
 * purge actually frees.
 */
export async function assertInstallFits(
	stagingDir: string,
	files: InventoryFile[],
	databasePath: string,
	blobRoots: string[],
	installBlobs: boolean
): Promise<void> {
	const stagingDevice = deviceOf(stagedTreeDir(stagingDir));
	const needed = new Map<string, { bytes: number; inodes: number; credit: number }>();
	const charge = (destination: string, bytes: number, credit: number) => {
		const entry = needed.get(destination) ?? { bytes: 0, inodes: 0, credit };
		entry.bytes += bytes;
		entry.inodes += 1;
		needed.set(destination, entry);
	};
	const databaseCredit = reclaimableBytes(databasePath);
	const databaseLinkable = deviceOf(databasePath) === stagingDevice;
	for (const file of files) {
		if (file.path.startsWith(BLOBS_PREFIX)) {
			const index = blobRootIndex(file.path);
			if (!installBlobs || index === undefined) continue;
			const root = blobRoots[index];
			if (root === undefined) {
				throw new ClientError(`The archive's blob root ${index} has no matching blob path in this instance`);
			}
			charge(root, deviceOf(root) === stagingDevice ? 0 : file.size, installBlobs ? reclaimableBytes(root) : 0);
		} else {
			charge(databasePath, databaseLinkable && IMMUTABLE_ENGINE_FILE.test(file.path) ? 0 : file.size, databaseCredit);
		}
	}
	const ledger = new DiskLedger();
	for (const [destination, { bytes, inodes, credit }] of needed) {
		const hold = await ledger.reserve(destination, Math.max(0, bytes - credit), inodes);
		hold.release(0);
	}
}

function mkdirDurably(directory: string): void {
	if (existsSync(directory)) return;
	mkdirDurably(dirname(directory));
	mkdirSync(directory);
	fsyncDirectory(dirname(directory));
}

async function copyVerified(source: string, destination: string, temporary: string, sha256: string): Promise<void> {
	const hash = createHash('sha256');
	await pipeline(
		createReadStream(source),
		async function* (chunks) {
			for await (const chunk of chunks) {
				hash.update(chunk);
				yield chunk;
			}
		},
		createWriteStream(temporary, { flags: 'wx' })
	);
	if (hash.digest('hex') !== sha256) {
		rmSync(temporary, { force: true });
		throw new Error(`Copying the staged ${source} did not reproduce its verified bytes`);
	}
	const fd = openSync(temporary, 'r');
	try {
		fsyncTolerantSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, destination);
}

function linkInPlace(source: string, destination: string): boolean {
	try {
		linkSync(source, destination);
		return true;
	} catch (error: any) {
		if (['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK', 'EACCES'].includes(error?.code)) return false;
		throw error;
	}
}

/**
 * Purges the target and installs the staged tree into it, `CURRENT` last so nothing can open a
 * half-installed database, every new directory and file durable before the next step. Blob roots are
 * replaced only when the archive carries blobs, as an engine-only restore leaves them untouched.
 */
export async function installStagedTree(
	stagingDir: string,
	files: InventoryFile[],
	databasePath: string,
	blobRoots: string[],
	installBlobs: boolean,
	operationTag: string
): Promise<void> {
	const treeDir = stagedTreeDir(stagingDir);
	mkdirDurably(databasePath);
	for (const entry of readdirSync(databasePath)) rmSync(join(databasePath, entry), { recursive: true, force: true });
	fsyncDirectory(databasePath);
	// a name no archive entry can take: it carries this restore's operation id
	const temporaryDir = join(databasePath, `.harper-restore-${operationTag}`);
	mkdirDurably(temporaryDir);
	const engineFiles = files.filter((file) => !file.path.startsWith(BLOBS_PREFIX));
	engineFiles.sort((a, b) => Number(a.path === 'CURRENT') - Number(b.path === 'CURRENT'));
	let sequence = 0;
	for (const file of engineFiles) {
		const source = join(treeDir, file.path);
		const destination = join(databasePath, file.path);
		mkdirDurably(dirname(destination));
		if (!(IMMUTABLE_ENGINE_FILE.test(file.path) && linkInPlace(source, destination))) {
			await copyVerified(source, destination, join(temporaryDir, String(sequence++)), file.sha256);
		}
		fsyncDirectory(dirname(destination));
	}
	rmSync(temporaryDir, { recursive: true, force: true });
	await fsyncTree(databasePath);
	if (!installBlobs) return;
	for (const root of blobRoots) rmSync(root, { recursive: true, force: true });
	const indices = new Set(
		files.map((file) => blobRootIndex(file.path)).filter((index): index is number => index !== undefined)
	);
	for (const index of indices) {
		const root = blobRoots[index];
		mkdirDurably(dirname(root));
		await copyTree(join(treeDir, 'blobs', String(index)), root);
		await fsyncTree(root);
	}
}
