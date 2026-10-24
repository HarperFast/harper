import { databases, getDatabases, table } from './databases.ts';
import { server } from '../server/Server.ts';
import * as env from '../utility/environment/environmentManager.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import * as logger from '../utility/logging/harper_logger.ts';
import {
	assertResidencyMapChange,
	residencyMapExtends,
	canonicalShards,
	createResidencyMap,
	defaultResidencyMap,
	expandResidencyMap,
	shardListDigest,
	validateResidencyMap,
	type ResidencyMapSnapshot,
	type ResidencyPolicy,
} from './residencyPolicy.ts';

export const RESIDENCY_MAP_TABLE = 'hdb_residency_slots';
const caches = new WeakMap<
	object,
	Map<
		string,
		{
			snapshot: ResidencyMapSnapshot;
			shards: Uint16Array;
			membership?: unknown;
			owners: Map<number, readonly string[]>;
		}
	>
>();
const DECLARATION_KEY = Symbol.for('residency_declaration');
let placementGuard: ((database: string, owners?: readonly string[], requireConnected?: boolean) => void) | undefined;

export function setResidencyPlacementGuard(guard: typeof placementGuard): void {
	placementGuard = guard;
}

export function residencyFailure(database: string, reason: string): never {
	const reported = new Int32Array(
		getResidencyMapTable().auditStore.getUserSharedBuffer(['residency-failure', database, reason], new ArrayBuffer(4))
	);
	if (Atomics.compareExchange(reported, 0, 0, 1) === 0) {
		logger.warn?.(`Declarative residency blocked for ${database}: ${reason}`);
	}
	throw new ClientError(`Declarative residency blocked for ${database}: ${reason}`, 503);
}

export function residencyDeclarationDatabases(): string[] {
	const catalog = databases.system?.[RESIDENCY_MAP_TABLE]?.dbisDB;
	if (!catalog) return [];
	return Array.from(
		catalog.getRange({ start: [DECLARATION_KEY], end: [DECLARATION_KEY, '\uffff'] }),
		({ key }: any) => key[1]
	);
}

let configuredList: unknown;
let configuredShards: number[] | undefined;
let configuredDigest: string | null = null;
let configuration: Readonly<{ shards: readonly number[] | undefined; shard: number; digest: string | null }>;
export function getResidencyConfiguration() {
	const value = env.get('replication_shards');
	const shard = env.get('replication_shard');
	if (value !== configuredList) {
		const shards = canonicalShards(value);
		configuredList = value;
		configuredShards = shards;
		configuredDigest = shardListDigest(shards);
		configuration = undefined;
	}
	if (!configuration || configuration.shard !== shard)
		configuration = Object.freeze({ shards: configuredShards, shard, digest: configuredDigest });
	return configuration;
}

export function assertResidencyConfiguration(database: string, hasMap: boolean): void {
	const { shards, shard } = getResidencyConfiguration();
	if (!shards && !hasMap) residencyFailure(database, 'replication.shards is required before a map is installed');
	if (shards && !shards.includes(shard)) residencyFailure(database, 'replication.shard is not in replication.shards');
	placementGuard?.(database);
}

export function getResidencyMapTable(): any {
	return (
		databases.system?.[RESIDENCY_MAP_TABLE] ??
		table({
			database: 'system',
			table: RESIDENCY_MAP_TABLE,
			audit: true,
			replicate: true,
			attributes: [
				{ name: 'database', isPrimaryKey: true },
				{ name: 'version' },
				{ name: 'digest' },
				{ name: 'slots' },
				{ name: 'ranges' },
			],
		})
	);
}

export function activeResidencySlots(database: string): number {
	let slots = 0;
	const Tables = Object.values(getDatabases()[database] ?? {});
	const catalog = Tables.find((Table) => Table.dbisDB)?.dbisDB;
	if (catalog)
		for (const { value } of catalog.getRange({ start: '', end: '\uffff' }))
			slots = Math.max(slots, value?.residency?.slots ?? 0);
	return slots;
}

export function readResidencyMap(database: string): ResidencyMapSnapshot | undefined {
	return databases.system?.[RESIDENCY_MAP_TABLE]?.primaryStore.getSync(database);
}

export function validateResidencyMapWrite(database: string, value: any, previous: any, replay = false): boolean {
	const next = validateResidencyMap(value, database);
	const activeSlots = activeResidencySlots(database);
	if (previous) {
		previous = validateResidencyMap(previous, database);
		if (previous.digest === next.digest || residencyMapExtends(next, previous)) return false;
		assertResidencyMapChange(previous, next, activeSlots);
	} else if (activeSlots && !replay)
		residencyFailure(database, 'the installed map is missing; restore it before placing writes');
	return true;
}

const installations = new Map<string, Promise<ResidencyMapSnapshot>>();

export async function installResidencyMap(
	snapshot: ResidencyMapSnapshot,
	options?: any
): Promise<ResidencyMapSnapshot> {
	snapshot = validateResidencyMap(snapshot);
	const database = snapshot.database;
	const preceding = installations.get(database);
	const operation = (async () => {
		await preceding?.catch(() => {});
		const Maps = getResidencyMapTable();
		const previous = Maps.primaryStore.getSync(database);
		if (previous?.digest === snapshot.digest) return validateResidencyMap(previous, database);
		if (!validateResidencyMapWrite(database, snapshot, previous)) return validateResidencyMap(previous, database);
		const { transaction } = await import('./transaction.ts');
		const context = {};
		await transaction(context, async () => {
			const resource = await Maps.getResource(database, context);
			resource._writeUpdate(database, snapshot, true, options);
		});
		return validateResidencyMap(readResidencyMap(database), database);
	})();
	installations.set(database, operation);
	try {
		return await operation;
	} finally {
		if (installations.get(database) === operation) installations.delete(database);
	}
}

export async function initializeResidencySlots(request: { database: string; slots: number; ranges: unknown }) {
	const previous = readResidencyMap(request.database);
	const candidate = createResidencyMap(request.database, request.slots, request.ranges, previous?.version ?? 1);
	if (previous?.digest === candidate.digest) return previous;
	if (previous) candidate.version++;
	return installResidencyMap(
		createResidencyMap(candidate.database, candidate.slots, candidate.ranges, candidate.version)
	);
}

export async function prepareResidencyDeclaration(
	database: string,
	name: string,
	policy: ResidencyPolicy
): Promise<void> {
	getDatabases();
	// Keep failed first activations visible even though their user table was never published.
	getResidencyMapTable().dbisDB.putSync([DECLARATION_KEY, database], true);
	const existing = databases[database]?.[name];
	const snapshot = readResidencyMap(database);
	assertResidencyConfiguration(database, !!snapshot);
	if (snapshot) {
		if (snapshot.slots < policy.slots) residencyFailure(database, 'installed map does not cover the declared slots');
		return;
	}
	if (existing) residencyFailure(database, 'an existing table requires its custom map before @residency activation');
	await installResidencyMap(defaultResidencyMap(database, policy.slots, env.get('replication_shards')));
}

export function getResidencyMap(database: string, requiredSlots = 1) {
	// User database replay can precede the directory scan opening the system database.
	const Maps = getResidencyMapTable();
	const row = Maps?.primaryStore.getSync(database);
	assertResidencyConfiguration(database, !!row);
	if (!row) residencyFailure(database, 'no residency map is installed');
	if (row.slots < requiredSlots) residencyFailure(database, 'installed map does not cover the declared slots');
	let cache = caches.get(Maps.primaryStore);
	if (!cache) caches.set(Maps.primaryStore, (cache = new Map()));
	let current = cache.get(database);
	if (!current || current.snapshot.digest !== row.digest) {
		const snapshot = validateResidencyMap(row, database);
		current = { snapshot, shards: expandResidencyMap(snapshot), owners: new Map() };
		cache.set(database, current);
	}
	return current;
}

export function residencyOwners(database: string, slot: number, slots: number): readonly string[] {
	if (!Number.isInteger(slot) || slot < 0 || slot >= slots)
		residencyFailure(database, 'missing or invalid record residency slot');
	const map = getResidencyMap(database, slots);
	if (map.membership !== server.shards) {
		map.membership = server.shards;
		map.owners.clear();
	}
	const shard = map.shards[slot];
	let owners = map.owners.get(shard);
	if (!owners) {
		const members = server.shards?.get(shard);
		if (!members?.length) residencyFailure(database, `shard ${shard} has no known owners`);
		owners = Object.freeze([...new Set(members.map((node: any) => (typeof node === 'string' ? node : node.name)))]);
		map.owners.set(shard, owners);
	}
	placementGuard?.(database, owners);
	return owners;
}

export function residencyIsLocal(database: string, slot: number, slots: number): boolean {
	if (!Number.isInteger(slot) || slot < 0 || slot >= slots)
		residencyFailure(database, 'missing or invalid record residency slot');
	return getResidencyMap(database, slots).shards[slot] === getResidencyConfiguration().shard;
}

export function requireConnectedResidencyOwner(database: string, owners: readonly string[]): void {
	if (!placementGuard) residencyFailure(database, 'new-owner confirmation requires a replication connection');
	placementGuard(database, owners, true);
}
