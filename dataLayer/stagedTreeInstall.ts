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
	renameSync,
	rmSync,
	statfsSync,
	statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { ClientError } from '../utility/errors/hdbError.ts';
import { fsyncDirectory } from '../utility/durableFile.ts';
import { fsyncTolerantSync } from '../utility/fsync.ts';
import { copyTree, fsyncTree } from './blobBackup.ts';
import { allocationUnit, DiskLedger } from './diskLedger.ts';
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

function validInventoryEntry(file: any): file is InventoryFile {
	const path = file?.path;
	return (
		typeof path === 'string' &&
		path !== '' &&
		!isAbsolute(path) &&
		normalize(path) === path.split('/').join(sep) &&
		!path.split('/').includes('..') &&
		Number.isSafeInteger(file.size) &&
		typeof file.sha256 === 'string'
	);
}

/** One entry per line, so a tree of millions of files never sits in the child's heap whole. */
async function* inventoryEntries(stagingDir: string): AsyncGenerator<InventoryFile> {
	const lines = createInterface({
		input: createReadStream(join(stagingDir, STAGED_INVENTORY_FILE)),
		crlfDelay: Infinity,
	});
	for await (const line of lines) {
		if (line === '') continue;
		let file: any;
		try {
			file = JSON.parse(line);
		} catch {
			file = line;
		}
		if (!validInventoryEntry(file)) {
			throw new Error(`The staged inventory in ${stagingDir} has an invalid entry: ${line.slice(0, 200)}`);
		}
		yield file;
	}
}

/** What the install will write where, in bytes and files, gathered while verifying. */
interface PlanEntry {
	bytes: number;
	files: number;
	/** Every directory the install creates, charged whether or not the files beside it are linked. */
	directoryBytes: number;
	directories: number;
	sample?: string;
}

export interface InstallPlan {
	immutableEngine: PlanEntry;
	otherEngine: PlanEntry;
	blobRoots: Map<number, PlanEntry>;
}

const emptyEntry = (): PlanEntry => ({ bytes: 0, files: 0, directoryBytes: 0, directories: 0 });

/**
 * Before anything is destroyed: every staged file must still be byte-for-byte what was verified when
 * the archive was staged — a restart restore can wait on its staging for a long time.
 */
export async function verifyStagedTree(
	stagingDir: string,
	databasePath: string,
	blobRoots: string[]
): Promise<InstallPlan> {
	const treeDir = stagedTreeDir(stagingDir);
	// a copy takes whole blocks of the volume it lands on, so a plan counts allocation, not file length
	const blockSizes = new Map<string, number>();
	const allocated = (destination: string, size: number) => {
		let blockSize = blockSizes.get(destination);
		if (blockSize === undefined) {
			blockSizes.set(destination, (blockSize = allocationUnit(statfsSync(nearestExisting(destination)).bsize)));
		}
		return Math.ceil(size / blockSize) * blockSize;
	};
	const createdDirectories = new Set<string>();
	const chargeDirectories = (entry: PlanEntry, destination: string, relativePath: string) => {
		const ancestors = relativePath.split('/').slice(0, -1);
		for (let depth = 0; depth <= ancestors.length; depth++) {
			const key = `${destination}\0${ancestors.slice(0, depth).join('/')}`;
			if (createdDirectories.has(key)) continue;
			createdDirectories.add(key);
			entry.directoryBytes += allocated(destination, 1);
			entry.directories++;
		}
	};
	const plan: InstallPlan = { immutableEngine: emptyEntry(), otherEngine: emptyEntry(), blobRoots: new Map() };
	for await (const file of inventoryEntries(stagingDir)) {
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
		if (file.path.startsWith(BLOBS_PREFIX)) {
			const index = blobRootIndex(file.path);
			if (index === undefined) continue;
			const entry = plan.blobRoots.get(index) ?? { ...emptyEntry(), sample: file.path };
			const destination = blobRoots[index] ?? databasePath;
			entry.bytes += allocated(destination, file.size);
			entry.files++;
			chargeDirectories(entry, destination, file.path.split('/').slice(2).join('/'));
			plan.blobRoots.set(index, entry);
		} else {
			const entry = IMMUTABLE_ENGINE_FILE.test(file.path) ? plan.immutableEngine : plan.otherEngine;
			entry.bytes += allocated(databasePath, file.size);
			entry.files++;
			if (entry === plan.immutableEngine) entry.sample ??= file.path;
			chargeDirectories(plan.otherEngine, databasePath, file.path);
		}
	}
	return plan;
}

function nearestExisting(path: string): string {
	let existing = path;
	while (!existsSync(existing)) existing = dirname(existing);
	return existing;
}

/** Whether a staged file can be hard-linked beside `destination`: tried, not inferred from the device. */
function canLink(source: string, destination: string, operationTag: string): boolean {
	const probe = join(nearestExisting(destination), `.harper-link-probe-${operationTag}`);
	rmSync(probe, { force: true });
	if (!linkInPlace(source, probe)) return false;
	rmSync(probe, { force: true });
	return true;
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
 * Refuses, before destruction, an install its destinations cannot hold. Every reservation is held until
 * all are made, so destinations sharing a device are admitted together; a file counts as free only where
 * a link was actually made to work, and a purge is credited only for files no other link keeps alive.
 */
export async function assertInstallFits(
	stagingDir: string,
	plan: InstallPlan,
	databasePath: string,
	blobRoots: string[],
	installBlobs: boolean,
	operationTag: string
): Promise<void> {
	const treeDir = stagedTreeDir(stagingDir);
	const needs: { destination: string; bytes: number; files: number; credit: number }[] = [];
	const engineLinks =
		plan.immutableEngine.sample !== undefined &&
		canLink(join(treeDir, plan.immutableEngine.sample), databasePath, operationTag);
	needs.push({
		destination: databasePath,
		bytes: plan.otherEngine.bytes + plan.otherEngine.directoryBytes + (engineLinks ? 0 : plan.immutableEngine.bytes),
		// a hard link takes no inode of its own
		files: plan.otherEngine.files + plan.otherEngine.directories + (engineLinks ? 0 : plan.immutableEngine.files),
		credit: reclaimableBytes(databasePath),
	});
	if (installBlobs) {
		for (const [index, root] of plan.blobRoots) {
			const destination = blobRoots[index];
			if (destination === undefined) {
				throw new ClientError(`The archive's blob root ${index} has no matching blob path in this instance`);
			}
			const links = root.sample !== undefined && canLink(join(treeDir, root.sample), destination, operationTag);
			needs.push({
				destination,
				bytes: root.directoryBytes + (links ? 0 : root.bytes),
				files: root.directories + (links ? 0 : root.files),
				credit: reclaimableBytes(destination),
			});
		}
	}
	const ledger = new DiskLedger();
	const holds: { release(bytes: number): void }[] = [];
	try {
		for (const { destination, bytes, files, credit } of needs) {
			holds.push(await ledger.reserve(nearestExisting(destination), Math.max(0, bytes - credit), files));
		}
	} finally {
		for (const hold of holds) hold.release(0);
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
	let sequence = 0;
	let current: InventoryFile | undefined;
	const install = async (file: InventoryFile) => {
		const source = join(treeDir, file.path);
		const destination = join(databasePath, file.path);
		mkdirDurably(dirname(destination));
		if (!(IMMUTABLE_ENGINE_FILE.test(file.path) && linkInPlace(source, destination))) {
			await copyVerified(source, destination, join(temporaryDir, String(sequence++)), file.sha256);
		}
		fsyncDirectory(dirname(destination));
	};
	const indices = new Set<number>();
	for await (const file of inventoryEntries(stagingDir)) {
		if (file.path.startsWith(BLOBS_PREFIX)) {
			const index = blobRootIndex(file.path);
			if (index !== undefined) indices.add(index);
		} else if (file.path === 'CURRENT') current = file;
		else await install(file);
	}
	if (!current) throw new Error(`The staged archive in ${stagingDir} has no CURRENT`);
	await install(current);
	rmSync(temporaryDir, { recursive: true, force: true });
	await fsyncTree(databasePath);
	if (!installBlobs) return;
	for (const root of blobRoots) rmSync(root, { recursive: true, force: true });
	for (const index of indices) {
		const root = blobRoots[index];
		mkdirDurably(dirname(root));
		await copyTree(join(treeDir, 'blobs', String(index)), root);
		await fsyncTree(root);
	}
}
