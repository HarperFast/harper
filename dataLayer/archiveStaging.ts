/**
 * Where an archive restore stages what it extracts, and how a staged area becomes the live database.
 * Every destination — the database directory and each blob root — gets a staged part in a reserved
 * `` `restore` `` directory beside it, on the same filesystem, so installing it is a rename and the
 * bytes are written once. The area's `staged.json` is written last; until it exists the area is still
 * being written. The rules are in dataLayer/DESIGN.md.
 */
import { randomUUID } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { threadId } from 'node:worker_threads';
import { ClientError } from '../utility/errors/hdbError.ts';
import { HTTP_STATUS_CODES } from '../utility/errors/commonErrors.ts';
import { fsyncDirectory, pathPresent, writeFileDurably } from '../utility/durableFile.ts';
import { get as envGet, getHdbBasePath } from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import logger from '../utility/logging/harper_logger.ts';
import { processIncarnation } from '../server/threads/processIncarnation.ts';
import { getQuotaStatus, getStorageSpaceStats, QUOTA_STATUS_MAX_AGE_MS } from '../server/storageReclamation.ts';
import { databaseRoots } from '../resources/databases.ts';
import { getBlobPathsForDatabaseName, rimrafSteadily } from '../resources/blob.ts';
import { nearestExistingAncestor } from './blobBackup.ts';
import { RESTORE_META_DIR, RESTORING_MARKER_SUFFIX, restoreMetaDir, restoreMetaKey } from './restoreMarker.ts';
import { RESTORE_RECEIPT_SUFFIX, readRestoreReceiptFile, type RestoreReceiptRead } from './restoreReceipt.ts';
import {
	ARCHIVE_MANIFEST_ENTRY,
	assertArchiveRestorable,
	type BackupArchiveManifest,
} from './backupArchiveManifest.ts';
import type { ArchiveRouter, EntryDestination } from './archiveExtraction.ts';

export const STAGED_SUFFIX = '.staged';
const STAGED_RECORD = 'staged.json';
const STAGED_RECORD_TEMP = 'staged.json.tmp';
const STAGED_RECORD_VERSION = 1;
const CHARGE_SUFFIX = '.charge';
const ENGINE_PART = 'db';
const BLOB_PART = 'blobs';
const PREVIOUS = 'previous';
const STAGING_ID_PATTERN = /^([0-9a-f]+)-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_INDEX = /^(0|[1-9]\d{0,5})$/;
const MIN_RESERVE_BYTES = 1024 ** 3;
const RESERVE_RATIO = 0.05;

export interface StagedPart {
	kind: 'engine' | 'blobs';
	/** The blob root's position in `storage.blobPaths`, which a record's blob reference persists. */
	index?: number;
	staged: string;
	destination: string;
	/** Where the replaced generation goes: inside this part's own area, so the move never crosses a filesystem. */
	previous: string;
	/** Of the staged directory, which a rename keeps: what proves the part was installed. */
	dev?: string;
	ino?: string;
}

export interface StagedRecord {
	version: number;
	staging_id: string;
	database: string;
	state: 'extracted' | 'proven';
	restored_from: string;
	archive: {
		sha256: string;
		bytes: number;
		inflated_bytes: number;
		entries: number;
		files: number;
		payload_bytes: number;
	};
	manifest: BackupArchiveManifest | null;
	waived: string[];
	parts: StagedPart[];
	generation?: { id: string; epoch: number };
	evidence?: Record<string, unknown>;
	created_at: number;
	proven_at?: number;
}

export interface StagingPlan {
	stagingId: string;
	/** The engine part's area, which holds `staged.json`; the area a receipt names. */
	stagingDir: string;
	/** Every area, the engine's first; a blob root beside the database directory shares the engine's. */
	areas: string[];
	parts: StagedPart[];
}

/** Names the process and thread that created an area, so a sweep can tell from the path alone. */
export function mintStagingId(): string {
	return `${processIncarnation ?? '0'}-${threadId}-${randomUUID()}`;
}

function parseStagingId(id: string): { incarnation: string; threadId: number } | undefined {
	const match = STAGING_ID_PATTERN.exec(id);
	return match ? { incarnation: match[1], threadId: Number(match[2]) } : undefined;
}

function stagingArea(destination: string, key: string, stagingId: string): string {
	return join(dirname(destination), RESTORE_META_DIR, key + STAGED_SUFFIX, stagingId);
}

export function planStaging(databaseDir: string, blobRoots: string[], stagingId: string): StagingPlan {
	const key = restoreMetaKey(databaseDir);
	const stagingDir = join(restoreMetaDir(databaseDir), key + STAGED_SUFFIX, stagingId);
	const parts: StagedPart[] = [
		{
			kind: 'engine',
			staged: join(stagingDir, ENGINE_PART),
			destination: databaseDir,
			previous: join(stagingDir, PREVIOUS, ENGINE_PART),
		},
	];
	const areas = new Set([stagingDir]);
	blobRoots.forEach((root, index) => {
		const area = stagingArea(root, key, stagingId);
		areas.add(area);
		parts.push({
			kind: 'blobs',
			index,
			staged: join(area, BLOB_PART, String(index)),
			destination: root,
			previous: join(area, PREVIOUS, BLOB_PART, String(index)),
		});
	});
	return { stagingId, stagingDir, areas: [...areas], parts };
}

function deviceOf(path: string): number {
	return statSync(existsSync(path) ? path : nearestExistingAncestor(path)).dev;
}

/**
 * The swap moves each destination aside and renames its staged part into place, so a destination at or
 * inside another would carry the other's newly installed part away after destruction had begun.
 */
function assertDestinationsApart(destinations: string[]): void {
	// through symlinks, as far as the path exists: two spellings of one directory are one destination
	const paths = destinations.map((destination) => {
		const path = resolve(destination);
		const existing = existsSync(path) ? path : nearestExistingAncestor(path);
		return join(realpathSync(existing), relative(existing, path));
	});
	for (const [index, path] of paths.entries()) {
		const other = paths.find(
			(candidate, at) => at !== index && (candidate === path ? at > index : candidate.startsWith(path + sep))
		);
		if (other === undefined) continue;
		throw new ClientError(
			`Cannot restore an archive while ${other} is ${other === path ? 'also' : 'inside'} ${path}: the restore installs the database directory and each blob path by renaming it, so each must be a directory of its own (storage.path, storage.blobPaths)`
		);
	}
}

/**
 * Creates every part empty; refuses, naming both paths, a part not on its destination's filesystem, and
 * destinations that overlap.
 */
export function createStagingAreas(plan: StagingPlan): void {
	assertDestinationsApart(plan.parts.map((part) => part.destination));
	for (const part of plan.parts) {
		mkdirSync(part.staged, { recursive: true, mode: 0o700 });
		mkdirSync(dirname(part.previous), { recursive: true, mode: 0o700 });
		if (statSync(part.staged).dev !== deviceOf(part.destination)) {
			throw new ClientError(
				`Cannot stage the archive beside ${part.destination}: ${part.staged} is on another filesystem, and a restore installs by rename`
			);
		}
	}
}

/** One entry at a time, so deleting a large tree never starves the threadpool a serving thread uses. Never rejects. */
export async function removeStagingArea(areas: Iterable<string>): Promise<void> {
	for (const area of areas) {
		try {
			const failures = await rimrafSteadily(area);
			if (failures.length > 0) throw new AggregateError(failures, `${failures.length} entries could not be removed`);
		} catch (error) {
			logger.warn(`Could not remove the restore staging area ${area}; the next startup removes it`, error);
		}
	}
}

/**
 * Every area a receipt's staged archive may occupy, the engine's last, since it holds the record the
 * others are found by; where the record is gone, the areas current configuration would have used.
 */
export function stagedAreasOfReceipt(receipt: {
	staging_dir?: string;
	database: string;
	database_path: string;
}): string[] {
	if (!receipt.staging_dir) return [];
	let areas: string[];
	try {
		areas = stagedAreas(readStagedRecord(receipt.staging_dir));
	} catch {
		areas = planStaging(
			receipt.database_path,
			getBlobPathsForDatabaseName(receipt.database),
			basename(receipt.staging_dir)
		).areas;
	}
	return [...areas.filter((area) => area !== receipt.staging_dir), receipt.staging_dir];
}

export function stagedAreas(record: Pick<StagedRecord, 'parts'>): string[] {
	return [
		...new Set(
			record.parts.map((part) => (part.kind === 'engine' ? dirname(part.staged) : dirname(dirname(part.staged))))
		),
	];
}

/**
 * The payload of every archive extracted since the quota report was taken, which the report cannot
 * count; all of them when the report has no time. One still staged is read from its `staged.json`, and
 * one installed from the same record where `keepInstalledCharge` moved it. An area without a readable `staged.json` is
 * still being written or was abandoned mid-extraction, and is skipped: sizing it would mean walking it.
 */
async function stagedSinceReport(reportedAt: number | undefined, plan: StagingPlan): Promise<number> {
	const locations = new Set(
		[...databaseRoots(), ...configuredBlobPaths()].map((path) => join(resolve(path), RESTORE_META_DIR))
	);
	// by staging id: an installed archive has its charge and its area until the area is removed
	const charges = new Map<string, number>();
	const count = async (id: string, file: string) => {
		if (id === plan.stagingId) return;
		let record: any;
		try {
			record = JSON.parse(await readFile(file, 'utf8'));
		} catch {
			return;
		}
		const bytes = record?.archive?.payload_bytes;
		if (!Number.isFinite(bytes) || bytes <= 0) return;
		if (Number.isFinite(reportedAt) && Number.isFinite(record.created_at) && record.created_at < reportedAt!) return;
		charges.set(id, bytes);
	};
	for (const location of locations) {
		for (const name of await listDirAsync(location)) {
			if (!name.endsWith(STAGED_SUFFIX)) continue;
			for (const id of await listDirAsync(join(location, name))) {
				await count(id, join(location, name, id, STAGED_RECORD));
			}
		}
	}
	// listed after the areas are read: a record gone from its area under that read was moved here first
	for (const location of locations) {
		for (const name of await listDirAsync(location)) {
			if (name.endsWith(CHARGE_SUFFIX)) await count(name.slice(0, -CHARGE_SUFFIX.length), join(location, name));
		}
	}
	let total = 0;
	for (const bytes of charges.values()) total += bytes;
	return total;
}

/**
 * Before a receipt's staged archive is removed. Where any part was installed, the payload is now live
 * data that no `staged.json` in an area counts, so while the quota report on disk predates the archive,
 * the record itself is moved beside the areas as its charge: a rename, which needs no space. Rejects
 * when the record cannot be moved, and the caller then leaves the area, whose record still charges.
 * Any report read later than a report's lifetime after an archive is newer than it, so charges that
 * old are removed here.
 */
export async function keepInstalledCharge(stagingDir: string): Promise<void> {
	const location = dirname(dirname(stagingDir));
	const oldest = Date.now() - QUOTA_STATUS_MAX_AGE_MS;
	for (const name of listDir(location)) {
		if (!name.endsWith(CHARGE_SUFFIX)) continue;
		try {
			let createdAt: unknown;
			try {
				createdAt = JSON.parse(readFileSync(join(location, name), 'utf8'))?.created_at;
			} catch {
				// unreadable charges nothing
			}
			if (!(Number(createdAt) >= oldest)) rmSync(join(location, name), { force: true });
		} catch (error) {
			logger.warn(`Could not remove the expired quota charge ${join(location, name)}`, error);
		}
	}
	let record: StagedRecord;
	try {
		record = readStagedRecord(stagingDir);
	} catch {
		return;
	}
	if (!record.parts.some((part) => sameInode(part.destination, part))) return;
	// no report, or one taken since: the next report read counts the archive itself
	const reportedAt = (await getQuotaStatus())?.updatedAt;
	if (reportedAt === undefined || reportedAt > record.created_at) return;
	renameDurably(join(stagingDir, STAGED_RECORD), join(location, record.staging_id + CHARGE_SUFFIX));
}

/**
 * One sample per filesystem, when staging starts: what is free there, less a reserve for the databases
 * it serves. Serialized extraction makes a statfs sample current; a quota-report sample is charged with
 * the archives staged since the report, whose time is read before the sample so it is no later.
 */
export async function stagingBudgets(plan: StagingPlan): Promise<Map<string, number>> {
	const reportedAt = (await getQuotaStatus())?.updatedAt;
	let unseen: number | undefined;
	const budgets = new Map<string, number>();
	// every part, not one per device: a part inside the quota's root can share a device with one outside it
	for (const part of plan.parts) {
		const device = String(statSync(part.staged).dev);
		const { available, size, basis } = await getStorageSpaceStats(part.staged);
		const charged = basis === 'quota' ? (unseen ??= await stagedSinceReport(reportedAt, plan)) : 0;
		const budget = Math.max(0, available - charged - Math.max(MIN_RESERVE_BYTES, Math.floor(size * RESERVE_RATIO)));
		budgets.set(device, Math.min(budget, budgets.get(device) ?? Infinity));
	}
	return budgets;
}

export function assertUploadFits(
	plan: StagingPlan,
	budgets: Map<string, number>,
	contentLength: number | undefined
): void {
	if (!Number.isFinite(contentLength)) return;
	let total = 0;
	for (const budget of budgets.values()) total += budget;
	if (contentLength! > total) {
		throw new ClientError(
			`The upload is ${contentLength} bytes, more than the ${total} this restore may use beside database directory ${plan.parts[0].destination} and its blob roots`,
			HTTP_STATUS_CODES.INSUFFICIENT_STORAGE
		);
	}
}

/** Routes each archive entry to its part. A manifest-less archive is treated as carrying the blob trees it has. */
export function archiveRouter(
	plan: StagingPlan,
	options: {
		acceptIncompatible: boolean;
		onManifest: (manifest: BackupArchiveManifest | null, waived: string[]) => void;
	}
): ArchiveRouter {
	const engine = plan.parts[0];
	const blobParts = plan.parts.filter((part) => part.kind === 'blobs');
	const budgetOf = new Map(plan.parts.map((part) => [part, String(statSync(part.staged).dev)]));
	return {
		admitManifest(manifest) {
			let waived: string[] = [];
			if (manifest) {
				waived = assertArchiveRestorable(manifest, { acceptIncompatible: options.acceptIncompatible });
				if (
					typeof manifest.blobs !== 'boolean' ||
					!Number.isSafeInteger(manifest.blob_root_count) ||
					manifest.blob_root_count < 0
				) {
					throw new ClientError(
						`Archive manifest ${ARCHIVE_MANIFEST_ENTRY} has no valid 'blobs' and 'blob_root_count'`
					);
				}
				if (!manifest.blobs) {
					throw new ClientError(
						'The archive was made with exclude_blobs, so restoring it would keep the live blob files, which cannot be proven before the database is replaced; take the archive without exclude_blobs'
					);
				}
				if (manifest.blob_root_count > blobParts.length) {
					throw new ClientError(
						`The archive has ${manifest.blob_root_count} blob root(s), but this instance has ${blobParts.length} blob path(s); configure matching storage.blobPaths before restoring`
					);
				}
			}
			options.onManifest(manifest, waived);
		},
		route(segments, kind): EntryDestination | null {
			if (segments.length === 1 && segments[0] === 'README.md' && kind === 'file') return null;
			if (segments[0] !== BLOB_PART) return { root: engine.staged, segments, budget: budgetOf.get(engine)! };
			if (segments.length === 1) {
				if (kind === 'directory') return null;
				throw new ClientError(`Archive entry "blobs" must be a directory`);
			}
			if (segments.length === 2 && segments[1] === 'README.md' && kind === 'file') return null;
			if (!CANONICAL_INDEX.test(segments[1])) {
				throw new ClientError(
					`Archive entry ${JSON.stringify(segments.join('/'))} is not under a blobs/<root index> directory`
				);
			}
			const index = Number(segments[1]);
			const part = blobParts[index];
			if (!part) {
				throw new ClientError(
					`The archive has blob root ${index}, but this instance has ${blobParts.length} blob path(s); configure matching storage.blobPaths before restoring`
				);
			}
			if (segments.length === 2 && kind === 'file')
				throw new ClientError(`Archive entry "blobs/${index}" must be a directory`);
			return { root: part.staged, segments: segments.slice(2), budget: budgetOf.get(part)! };
		},
	};
}

function identity(path: string): { dev: string; ino: string } {
	const stats = statSync(path, { bigint: true });
	return { dev: String(stats.dev), ino: String(stats.ino) };
}

export function withIdentities(parts: StagedPart[]): StagedPart[] {
	return parts.map((part) => ({ ...part, ...identity(part.staged) }));
}

export function writeStagedRecord(stagingDir: string, record: StagedRecord): void {
	writeFileDurably(join(stagingDir, STAGED_RECORD), JSON.stringify(record), STAGED_RECORD_TEMP);
}

export function readStagedRecord(stagingDir: string, databaseName?: string): StagedRecord {
	let record: any;
	try {
		record = JSON.parse(readFileSync(join(stagingDir, STAGED_RECORD), 'utf8'));
	} catch (error: any) {
		throw new ClientError(
			`The staged archive is no longer available (${error?.code ?? 'unreadable'}); upload it again`,
			410
		);
	}
	if (
		!record ||
		record.version !== STAGED_RECORD_VERSION ||
		(record.state !== 'extracted' && record.state !== 'proven') ||
		!Array.isArray(record.parts) ||
		record.parts[0]?.kind !== 'engine' ||
		record.staging_id !== basename(stagingDir)
	) {
		throw new ClientError('The staged archive record is not valid; upload the archive again', 410);
	}
	if (databaseName !== undefined && record.database !== databaseName) {
		throw new ClientError(`The staged archive was uploaded for database '${record.database}', not '${databaseName}'`);
	}
	return record as StagedRecord;
}

export function stagingDirFor(databaseDir: string, stagingId: string): string {
	if (typeof stagingId !== 'string' || !STAGING_ID_PATTERN.test(stagingId)) {
		throw new ClientError(`'staging_id' does not name a staged archive`);
	}
	return join(restoreMetaDir(databaseDir), restoreMetaKey(databaseDir) + STAGED_SUFFIX, stagingId);
}

type PartAction = 'move-aside-and-install' | 'install' | 'installed';

function sameInode(path: string, part: StagedPart): boolean {
	try {
		const stats = statSync(path, { bigint: true });
		return String(stats.dev) === part.dev && String(stats.ino) === part.ino;
	} catch (error: any) {
		if (error?.code === 'ENOENT') return false;
		throw error;
	}
}

/** Decided from the disk alone, so a retry after any crash runs the same table. */
function partAction(part: StagedPart): PartAction {
	const staged = pathPresent(part.staged);
	const destination = pathPresent(part.destination);
	const previous = pathPresent(part.previous);
	if (!staged) {
		if (destination && sameInode(part.destination, part)) return 'installed';
		throw new Error(
			`Restore staging for ${part.destination} is gone and the destination is not the staged directory; the swap cannot continue`
		);
	}
	if (!sameInode(part.staged, part)) {
		throw new Error(`The staged directory ${part.staged} is not the one the staged proof recorded`);
	}
	if (!destination) return 'install';
	if (previous) {
		throw new Error(
			`${part.destination} exists although its replaced generation was already moved to ${part.previous}; the swap stops rather than replace it`
		);
	}
	return 'move-aside-and-install';
}

/**
 * Before anything is destroyed: the record is proven, every destination is where current configuration
 * puts it, and every part is either still staged or already installed.
 */
export function verifyStagedSwap(record: StagedRecord, databaseDir: string, blobRoots: string[]): void {
	if (record.state !== 'proven') throw new Error('The staged archive has not been proven');
	const blobParts = record.parts.filter((part) => part.kind === 'blobs');
	const expected = [databaseDir, ...blobRoots].map((path) => resolve(path));
	const recorded = [record.parts[0].destination, ...blobParts.map((part) => part.destination)].map((path) =>
		resolve(path)
	);
	if (record.parts[0].kind !== 'engine' || expected.join('\n') !== recorded.join('\n')) {
		throw new ClientError(
			`The archive was staged for ${recorded.join(', ')}, but this instance now places database '${record.database}' at ${expected.join(', ')} (storage.path or storage.blobPaths changed); restore the archive again`,
			409
		);
	}
	assertDestinationsApart(expected);
	for (const part of record.parts) partAction(part);
}

function syncRenameParents(from: string, to: string): void {
	fsyncDirectory(dirname(to));
	if (dirname(from) !== dirname(to)) fsyncDirectory(dirname(from));
}

function renameDurably(from: string, to: string): void {
	renameSync(from, to);
	syncRenameParents(from, to);
}

export function applyStagedSwap(record: StagedRecord): void {
	for (const part of record.parts) {
		const action = partAction(part);
		// a rename found already done may be one whose parent directories were never flushed
		if (action === 'move-aside-and-install') renameDurably(part.destination, part.previous);
		else if (pathPresent(part.previous)) syncRenameParents(part.destination, part.previous);
		if (action === 'installed') syncRenameParents(part.staged, part.destination);
		else renameDurably(part.staged, part.destination);
	}
}

function configuredBlobPaths(): string[] {
	const blobPaths: string[] | undefined = envGet(CONFIG_PARAMS.STORAGE_BLOBPATHS);
	return blobPaths?.length ? blobPaths : [join(getHdbBasePath(), 'blobs')];
}

async function listDirAsync(directory: string): Promise<string[]> {
	try {
		return await readdir(directory);
	} catch {
		return [];
	}
}

function listDir(directory: string): string[] {
	try {
		return readdirSync(directory);
	} catch (error: any) {
		if (error?.code !== 'ENOENT') logger.warn(`Could not list ${directory} for restore staging`, error);
		return [];
	}
}

/**
 * After startup recovery: every area an earlier process created that no receipt names, as its own or as
 * one it took over. A key whose receipt cannot be read, or that has a marker and no readable receipt,
 * keeps every area, since recovery leaves that database blocked rather than guess what it needs.
 * Returns what was removed.
 */
export function sweepStagingAtStartup(roots: string[] = databaseRoots(), blobPaths = configuredBlobPaths()): string[] {
	// decided per root and then joined, so no root's receipt can clear another root's hold on a key
	const held = new Set<string>();
	const owned = new Set<string>();
	for (const root of roots) {
		const metaDir = join(root, RESTORE_META_DIR);
		const receipts = new Map<string, RestoreReceiptRead>();
		const markers: string[] = [];
		for (const name of listDir(metaDir)) {
			if (name.endsWith(RESTORE_RECEIPT_SUFFIX)) {
				const read = readRestoreReceiptFile(join(metaDir, name));
				receipts.set(name.slice(0, -RESTORE_RECEIPT_SUFFIX.length), read);
				if (read.kind !== 'valid') continue;
				for (const dir of [read.receipt.staging_dir, ...(read.receipt.superseded_staging_dirs ?? [])])
					if (dir) owned.add(basename(dir));
			} else if (name.endsWith(RESTORING_MARKER_SUFFIX)) {
				markers.push(name.slice(0, -RESTORING_MARKER_SUFFIX.length));
			}
		}
		for (const [key, read] of receipts) if (read.kind === 'unreadable') held.add(key);
		for (const key of markers) if (receipts.get(key)?.kind !== 'valid') held.add(key);
	}
	const removed: string[] = [];
	const locations = new Set([...roots, ...blobPaths].map((path) => join(resolve(path), RESTORE_META_DIR)));
	for (const location of locations) {
		for (const name of listDir(location)) {
			if (!name.endsWith(STAGED_SUFFIX)) continue;
			if (held.has(name.slice(0, -STAGED_SUFFIX.length))) continue;
			for (const id of listDir(join(location, name))) {
				const owner = parseStagingId(id);
				if ((owner && owner.incarnation === processIncarnation) || owned.has(id)) continue;
				const area = join(location, name, id);
				try {
					if (!lstatSync(area).isDirectory()) continue;
					rmSync(area, { recursive: true, force: true });
					removed.push(area);
				} catch (error) {
					logger.warn(`Could not remove the restore staging area ${area}`, error);
				}
			}
		}
	}
	return removed;
}
