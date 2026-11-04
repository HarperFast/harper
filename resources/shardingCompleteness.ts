import { databases, getDatabaseCatalog, database as openDatabase } from './databases.ts';
import { getDatabaseGeneration } from './auditStore.ts';
import { readResidencyMap, getResidencyConfiguration, acquireResidencyMapFence } from './residencyMaps.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import * as logger from '../utility/logging/harper_logger.ts';

const assertionKey = Symbol.for('sharding-existing-owner');
const conversionKey = Symbol.for('sharding-converted-table');
const baselineStates = new WeakMap<object, Map<string, Int32Array>>();

export function shardingBaselineState(root: any, database: string): Int32Array {
	let states = baselineStates.get(root);
	if (!states) baselineStates.set(root, (states = new Map()));
	let state = states.get(database);
	if (!state) {
		state = new Int32Array(root.getUserSharedBuffer(['sharding-baseline-ready', database], new ArrayBuffer(4)));
		states.set(database, state);
	}
	return state;
}

type TableIdentity = { name: string; generation: string; createdTime: number };
type RootIdentity = { generation: string; tables: TableIdentity[] };
type OwnerAssertion = { digest: string; shard: number; roots: RootIdentity[] };

export function shardingNativeRoots(database: string): { root: any; catalog: any; auditStore: any }[] {
	const roots = new Map<object, { root: any; catalog: any; auditStore: any }>();
	for (const Table of Object.values(databases[database] ?? {})) {
		const root = Table.primaryStore?.rootStore;
		if (root && Table.dbisDB) roots.set(root, { root, catalog: Table.dbisDB, auditStore: Table.auditStore });
	}
	if (!roots.size) {
		const root = openDatabase({ database, table: undefined });
		roots.set(root, { root, catalog: getDatabaseCatalog(database), auditStore: root.auditStore });
	}
	return [...roots.values()];
}

function tableIdentity(name: string, descriptor: any): TableIdentity {
	return { name, generation: descriptor.generation ?? '', createdTime: descriptor.createdTime ?? 0 };
}

function nativeRootIdentity({ catalog, auditStore }: ReturnType<typeof shardingNativeRoots>[number]): RootIdentity {
	const generation = getDatabaseGeneration(auditStore)?.id;
	if (!generation)
		throw new ClientError('Sharding completeness assertion requires a durable local root generation', 503);
	const tables = [];
	for (const { key, value } of catalog.getRange({ start: '', end: '\uffff' })) {
		if (
			typeof key !== 'string' ||
			!value ||
			value.dropping ||
			(!value.isPrimaryKey && !key.endsWith('/')) ||
			key.startsWith('/')
		)
			continue;
		tables.push(tableIdentity(key.slice(0, key.indexOf('/')), value));
	}
	tables.sort((a, b) => a.name.localeCompare(b.name));
	return { generation, tables };
}

export function markShardingConversion(catalog: any, name: string, descriptor: any, root: any, database: string): void {
	Atomics.store(shardingBaselineState(root, database), 0, 0);
	catalog.putSync([conversionKey, name], tableIdentity(name, descriptor));
}

export function shardingConvertedTables(database: string): { catalog: any; tables: TableIdentity[] }[] {
	return shardingNativeRoots(database).map(({ catalog }) => {
		const tables = new Map<string, TableIdentity>();
		for (const { key, value } of catalog.getRange({ start: '', end: '\uffff' })) {
			if (
				typeof key !== 'string' ||
				!value?.residency ||
				value.dropping ||
				(!value.isPrimaryKey && !key.endsWith('/')) ||
				key.startsWith('/')
			)
				continue;
			const name = key.slice(0, key.indexOf('/'));
			const converted = catalog.getSync([conversionKey, name]);
			if (converted && JSON.stringify(converted) === JSON.stringify(tableIdentity(name, value)))
				tables.set(name, converted);
		}
		return { catalog, tables: [...tables.values()] };
	});
}

export function hasExistingOwnerAssertion(database: string): boolean {
	const map = readResidencyMap(database);
	if (!map) return false;
	const roots = shardingNativeRoots(database);
	const identities = roots.map(nativeRootIdentity).sort((a, b) => a.generation.localeCompare(b.generation));
	const generations = JSON.stringify(identities.map((root) => root.generation));
	const converted = shardingConvertedTables(database);
	let expected: string;
	for (const { catalog, auditStore } of roots) {
		const assertion: OwnerAssertion = catalog.getSync([assertionKey, database]);
		if (
			!assertion ||
			assertion.digest !== map.digest ||
			assertion.shard !== getResidencyConfiguration().shard ||
			JSON.stringify(assertion.roots.map((root) => root.generation)) !== generations
		)
			return false;
		const encoded = JSON.stringify(assertion);
		if (expected && expected !== encoded) return false;
		expected = encoded;
		const captured = assertion.roots.find((root) => root.generation === getDatabaseGeneration(auditStore)?.id);
		for (const current of converted.find((root) => root.catalog === catalog)?.tables ?? [])
			if (!captured?.tables.some((table) => JSON.stringify(table) === JSON.stringify(current))) return false;
	}
	return roots.length > 0;
}

export async function assertExistingShardOwner(database: string, expectedDigest: string, actor?: string) {
	const release = acquireResidencyMapFence(database, {});
	try {
		const map = readResidencyMap(database);
		if (!map || map.digest !== expectedDigest)
			throw new ClientError(
				`Shard map digest for ${database} differs from expected_digest; completeness assertion refused`,
				409
			);
		const shard = getResidencyConfiguration().shard;
		if (!Number.isInteger(shard) || !map.ranges.some((range) => range.shard === shard))
			throw new ClientError(
				`Node shard ${shard} owns no slots in ${database}; an existing-owner assertion is not applicable`,
				400
			);
		const roots = shardingNativeRoots(database);
		const identities = roots.map(nativeRootIdentity).sort((a, b) => a.generation.localeCompare(b.generation));
		const assertion: OwnerAssertion = { digest: map.digest, shard, roots: identities };
		const encoded = JSON.stringify(assertion);
		let changed = false;
		for (const { catalog } of roots) {
			if (JSON.stringify(catalog.getSync([assertionKey, database])) === encoded) continue;
			await catalog.put([assertionKey, database], assertion);
			changed = true;
		}
		for (const { catalog } of roots) await catalog.flush({ allowWriteStall: true });
		if (changed)
			logger.warn?.(
				`Operator ${actor ?? 'application'} asserted existing-owner completeness for ${database}, shard ${shard}, map ${map.digest}; Harper has not verified completeness`
			);
		return map;
	} finally {
		release();
	}
}
