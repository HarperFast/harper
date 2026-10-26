import { setDatabaseLiveGuard, setDatabaseBaselineGuard } from './databaseLiveGuard.ts';
import { ensureShardingConfiguration, shardingRecoveryConfiguration } from '../config/shardingConfiguration.ts';
import { isMainThread } from 'node:worker_threads';
import { databases, database as openDatabase, getDatabaseCatalog, getDatabases, table } from './databases.ts';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import { CONFIG_PARAMS, SYSTEM_TABLE_NAMES } from '../utility/hdbTerms.ts';
import { server } from '../server/Server.ts';
import * as env from '../utility/environment/environmentManager.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import * as logger from '../utility/logging/harper_logger.ts';
import {
	assertResidencyMapChange,
	normalizeResidencyPolicy,
	compileResidencyPolicy,
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

export const RESIDENCY_MAP_TABLE = SYSTEM_TABLE_NAMES.RESIDENCY_SLOTS_TABLE_NAME;
const caches = new WeakMap<
	object,
	Map<
		string,
		{
			snapshot: ResidencyMapSnapshot;
			shards: Uint16Array;
			membership?: unknown;
			localShard?: number;
			owners: Map<number, readonly string[]>;
		}
	>
>();
const DECLARATION_KEY = Symbol.for('residency_declaration');
const mapFences = new WeakMap<object, Map<string, { owner: object; references: number }>>();
let placementGuard:
	| ((database: string, owners?: readonly string[], requireConnected?: boolean, shard?: number, root?: object) => void)
	| undefined;
const ownerShards = new WeakMap<readonly string[], number>();

export function setResidencyPlacementGuard(guard: typeof placementGuard): void {
	placementGuard = guard;
}

const guardedRoots = new WeakMap<object, Map<string, () => string | undefined>>();
let baselineGuard: ((database: string, root: object) => string | undefined) | undefined;

export function setResidencyBaselineGuard(guard: typeof baselineGuard): void {
	baselineGuard = guard;
}

export function registerResidencyRoot(database: string, root: object, declared = false): void {
	if (database === 'system' || guardedRoots.get(root)?.has(database)) return;
	const mapTable = Object.getOwnPropertyDescriptor(databases, 'system')?.value?.[RESIDENCY_MAP_TABLE];
	const catalog = mapTable?.dbisDB;
	if (
		!declared &&
		!catalog?.getSync([DECLARATION_KEY, database]) &&
		!Object.values(databases[database] ?? {}).some((Table) => Table.residency)
	)
		return;
	let hasMap = !!mapTable?.primaryStore.getSync(database);
	const guard = () => {
		try {
			assertResidencyEngine(database, root);
			if (!hasMap)
				hasMap = !!Object.getOwnPropertyDescriptor(databases, 'system')?.value?.[
					RESIDENCY_MAP_TABLE
				]?.primaryStore.getSync(database);
			assertResidencyConfiguration(database, hasMap);
			if (!hasMap) return 'no shard map is installed';
		} catch (error) {
			return error.message ?? 'sharding agreement is unavailable';
		}
	};
	let rootGuards = guardedRoots.get(root);
	if (!rootGuards) {
		rootGuards = new Map();
		guardedRoots.set(root, rootGuards);
		setDatabaseLiveGuard(root, guard);
		setDatabaseBaselineGuard(root, () => {
			if (!baselineGuard) return;
			for (const database of rootGuards.keys()) {
				const reason = baselineGuard(database, root);
				if (reason) return reason;
			}
		});
	} else {
		setDatabaseLiveGuard(root, () => {
			for (const guard of rootGuards.values()) {
				const reason = guard();
				if (reason) return reason;
			}
		});
	}
	rootGuards.set(database, guard);
}

export class ResidencyPlacementError extends ClientError {}
export class ResidencyConfigurationError extends ResidencyPlacementError {}

export function recordResidencyDeclaration(database: string): void {
	const catalog = getResidencyMapTable().dbisDB;
	const key = [DECLARATION_KEY, database];
	if (!catalog.getSync(key)) catalog.putSync(key, true);
}

export function assertResidencyEngine(database: string, root?: object): void {
	const roots = root
		? [root]
		: Object.values(databases[database] ?? {})
				.map((Table) => Table.primaryStore?.rootStore)
				.filter(Boolean);
	if (!roots.length) roots.push(openDatabase({ database, table: undefined }));
	if (roots.some((root) => !(root instanceof RocksDatabase)))
		throw new ResidencyConfigurationError(
			`Sharding for ${database} requires RocksDB; LMDB supports legacy residency only`,
			503
		);
}

function residencyFailure(database: string, reason: string): never {
	const reported = new Int32Array(
		getResidencyMapTable().auditStore.getUserSharedBuffer(['residency-failure', database, reason], new ArrayBuffer(4))
	);
	if (Atomics.compareExchange(reported, 0, 0, 1) === 0) {
		logger.warn?.(`Sharding blocked for ${database}: ${reason}`);
	}
	throw new ResidencyConfigurationError(`Sharding blocked for ${database}: ${reason}`, 503);
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
let recoveryConfiguration: typeof configuration;
export function getResidencyConfiguration(forRecovery = false) {
	if (forRecovery && shardingRecoveryConfiguration) {
		const shard = shardingRecoveryConfiguration.shard;
		if (shard !== undefined && (!Number.isInteger(shard) || shard < 0 || shard > 65535))
			throw new ClientError('replication.shard must be an integer from 0 through 65535', 400);
		if (!recoveryConfiguration) {
			const shards = canonicalShards(shardingRecoveryConfiguration.shards);
			recoveryConfiguration = Object.freeze({
				shards,
				shard: shardingRecoveryConfiguration.shard,
				digest: shardListDigest(shards),
			});
		}
		return recoveryConfiguration;
	}
	const value = env.get(CONFIG_PARAMS.REPLICATION_SHARDS);
	const shard = env.get(CONFIG_PARAMS.REPLICATION_SHARD);
	if (shard !== undefined && (!Number.isInteger(shard) || shard < 0 || shard > 65535))
		throw new ClientError('replication.shard must be an integer from 0 through 65535', 400);
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

function assertResidencyConfiguration(
	database: string,
	hasMap: boolean,
	forRecovery = false,
	snapshot?: typeof configuration
): void {
	let current;
	try {
		current = snapshot ?? getResidencyConfiguration(forRecovery);
	} catch (error) {
		residencyFailure(database, error.message);
	}
	const { shards, shard } = current;
	if (!shards && !hasMap) residencyFailure(database, 'replication.shards is required before a map is installed');
	if (shards && !shards.includes(shard)) residencyFailure(database, 'replication.shard is not in replication.shards');
	if (!forRecovery) placementGuard?.(database);
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
	const catalogs = new Set(
		Object.values(databases[database] ?? {})
			.map((Table) => Table.dbisDB)
			.filter(Boolean)
	);
	if (!catalogs.size) catalogs.add(getDatabaseCatalog(database));
	for (const catalog of catalogs)
		for (const { value } of catalog.getRange({ start: '', end: '\uffff' }))
			slots = Math.max(slots, value?.residency?.slots ?? 0);
	return slots;
}

export function readResidencyMap(database: string): ResidencyMapSnapshot | undefined {
	return getResidencyMapTable().primaryStore.getSync(database);
}

export function acquireResidencyMapFence(database: string, owner: object): () => void {
	const store = getResidencyMapTable().primaryStore;
	let fences = mapFences.get(store);
	if (!fences) mapFences.set(store, (fences = new Map()));
	let fence = fences.get(database);
	const key = [Symbol.for('residency-map-activation'), database];
	if (!fence || fence.owner !== owner) {
		if (!store.tryLock(key))
			throw Object.assign(
				new ClientError(`Shard map update or activation is in progress for ${database}; retry`, 503),
				{
					residencyMapBusy: true,
				}
			);
		fences.set(database, (fence = { owner, references: 0 }));
	}
	fence.references++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--fence.references === 0) {
			fences.delete(database);
			store.unlock(key);
		}
	};
}

export function validateResidencyMapWrite(database: string, value: any, previous: any, replay = false): boolean {
	const next = validateResidencyMap(value, database);
	// Opening user catalogs during system replay would bypass their pending audit recovery.
	const activeSlots = replay ? 0 : activeResidencySlots(database);
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

export async function initializeResidencySlots(request: {
	database: string;
	slots?: number;
	ranges?: unknown;
	existing_owner?: unknown;
	expected_digest?: unknown;
	hdb_user?: { username?: string };
}) {
	const assertion = Object.hasOwn(request, 'existing_owner');
	if (
		assertion &&
		(request.existing_owner !== true ||
			typeof request.expected_digest !== 'string' ||
			Object.hasOwn(request, 'slots') ||
			Object.hasOwn(request, 'ranges'))
	)
		throw new ClientError(
			'An existing-owner assertion requires existing_owner: true and expected_digest, without slots or ranges',
			400
		);
	if (!assertion && Object.hasOwn(request, 'expected_digest'))
		throw new ClientError('expected_digest requires existing_owner: true', 400);
	getDatabases();
	assertResidencyEngine(request.database);
	if (assertion) {
		const { assertExistingShardOwner } = await import('./shardingCompleteness.ts');
		return assertExistingShardOwner(request.database, request.expected_digest as string, request.hdb_user?.username);
	}
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
	policy: Partial<ResidencyPolicy>
): Promise<Readonly<ResidencyPolicy>> {
	if (!isMainThread) await ensureShardingConfiguration();
	getDatabases();
	// Keep failed first activations visible even though their user table was never published.
	recordResidencyDeclaration(database);
	for (const Table of Object.values(databases[database] ?? {}))
		if (Table.primaryStore?.rootStore) registerResidencyRoot(database, Table.primaryStore.rootStore, true);
	assertResidencyEngine(database);
	const root = openDatabase({ database, table: name });
	registerResidencyRoot(database, root, true);
	assertResidencyEngine(database, root);
	const existing = databases[database]?.[name];
	const snapshot = readResidencyMap(database);
	const resolved = normalizeResidencyPolicy({
		...policy,
		slots: policy.slots === undefined ? (snapshot?.slots ?? 1024) : policy.slots,
	});
	compileResidencyPolicy(resolved);
	const current = getResidencyConfiguration();
	assertResidencyConfiguration(database, !!snapshot, false, current);
	if (snapshot) {
		if (snapshot.slots !== resolved.slots)
			throw new ClientError(
				`@sharded slot count ${resolved.slots} differs from database ${database} map count ${snapshot.slots}`,
				400
			);
		return resolved;
	}
	if (existing) residencyFailure(database, 'an existing table requires its custom map before @sharded activation');
	try {
		await installResidencyMap(defaultResidencyMap(database, resolved.slots, current.shards));
	} catch (error) {
		if (!(error instanceof ClientError) || !readResidencyMap(database)) throw error;
	}
	return prepareResidencyDeclaration(database, name, policy);
}

export function getResidencyMap(database: string, requiredSlots?: number, forRecovery = false) {
	const Maps = getResidencyMapTable();
	const row = Maps?.primaryStore.getSync(database);
	assertResidencyConfiguration(database, !!row, forRecovery);
	if (!row) residencyFailure(database, 'no shard map is installed');
	if (requiredSlots !== undefined && row.slots !== requiredSlots)
		residencyFailure(database, `table slot count ${requiredSlots} differs from database map count ${row.slots}`);
	let cache = caches.get(Maps.primaryStore);
	if (!cache) caches.set(Maps.primaryStore, (cache = new Map()));
	let current = cache.get(database);
	if (!current || current.snapshot.digest !== row.digest) {
		let snapshot: ResidencyMapSnapshot;
		try {
			snapshot = validateResidencyMap(row, database);
		} catch (error) {
			residencyFailure(database, error.message);
		}
		current = { snapshot, shards: expandResidencyMap(snapshot), owners: new Map() };
		cache.set(database, current);
	}
	return current;
}

export function residencyOwners(database: string, slot: number, slots: number): readonly string[] {
	if (!Number.isInteger(slot) || slot < 0 || slot >= slots)
		residencyFailure(database, 'missing or invalid record sharding slot');
	const map = getResidencyMap(database, slots);
	const localShard = getResidencyConfiguration().shard;
	if (map.membership !== server.shards || map.localShard !== localShard) {
		map.membership = server.shards;
		map.localShard = localShard;
		map.owners.clear();
	}
	const shard = map.shards[slot];
	let owners = map.owners.get(shard);
	if (!owners) {
		const members = server.shards?.get(shard);
		if (!members?.length) residencyFailure(database, `shard ${shard} has no known owners`);
		owners = Object.freeze([...new Set(members.map((node: any) => (typeof node === 'string' ? node : node.name)))]);
		// Recovery uses the configured shard before peer discovery. Never admit live writes under
		// a conflicting self-membership view that would replay with a different ownership decision.
		if (owners.includes(server.hostname) !== (shard === localShard))
			residencyFailure(database, 'local shard membership disagrees with replication.shard');
		map.owners.set(shard, owners);
		ownerShards.set(owners, shard);
	}
	placementGuard?.(database, owners, undefined, shard);
	return owners;
}

export function residencyIsLocal(database: string, slot: number, slots: number): boolean {
	if (!Number.isInteger(slot) || slot < 0 || slot >= slots)
		residencyFailure(database, 'missing or invalid record sharding slot');
	return getResidencyMap(database, slots, true).shards[slot] === getResidencyConfiguration().shard;
}

export function requireConnectedResidencyOwner(database: string, owners: readonly string[]): void {
	if (!placementGuard) residencyFailure(database, 'new-owner confirmation requires a replication connection');
	placementGuard(database, owners, true, ownerShards.get(owners));
}

export function assertResidencyWriteRoute(database: string, owners: readonly string[], root?: object): void {
	placementGuard?.(database, owners, false, ownerShards.get(owners), root);
}
