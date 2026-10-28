import { Transaction } from '@harperfast/rocksdb-js';
import { get as envGet } from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { writeKey } from 'ordered-binary';
import { ClientError } from '../utility/errors/hdbError.ts';
import { commonValidators, schemaRegex } from '../validation/common_validators.ts';

export interface ResidencyPolicy {
	slots: number;
	by?: string;
	slotFrom?: string;
	byAttribute: boolean;
}

export interface ResidencyRange {
	start: number;
	end: number;
	shard: number;
}

export interface ResidencyMapSnapshot {
	database: string;
	version: number;
	digest: string;
	slots: number;
	ranges: ResidencyRange[];
}

export function unsupportedResidencyPolicy(policy: Partial<ResidencyPolicy>, table: string): string | undefined {
	if (!policy.byAttribute && policy.by === undefined && policy.slotFrom === undefined) return;
	if (envGet(CONFIG_PARAMS.REPLICATION_EXPERIMENTALATTRIBUTESLOTS) !== true)
		return `Attribute-derived sharding is not supported yet for ${table}; see https://github.com/HarperFast/harper-pro/issues/1178`;
	if (policy.byAttribute || policy.by !== undefined) {
		if (typeof (Transaction.prototype as any).usesAbortMarkers !== 'function')
			return `Attribute-derived sharding for ${table} requires a binding with txn.usesAbortMarkers()`;
		if (envGet(CONFIG_PARAMS.STORAGE_ROCKS_TRANSACTIONLOGABORTMARKERS) !== true)
			return `Attribute-derived sharding for ${table} requires storage.rocks.transactionLogAbortMarkers enabled`;
	}
}

function validateSlotCount(slots: unknown): asserts slots is number {
	if (!Number.isInteger(slots) || (slots as number) < 1 || (slots as number) > 65536)
		throw new ClientError('@sharded slots must be an integer from 1 to 65536', 400);
}

export function normalizeResidencyPolicy(value: any): Readonly<ResidencyPolicy> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new ClientError('@sharded requires a policy object', 400);
	for (const key of Object.keys(value))
		if (!['slots', 'by', 'slotFrom', 'byAttribute'].includes(key))
			throw new ClientError(`Unknown @sharded argument ${key}`, 400);
	validateSlotCount(value.slots);
	if (value.by !== undefined && (typeof value.by !== 'string' || !value.by.trim()))
		throw new ClientError('@sharded by must be a nonempty attribute name', 400);
	if (value.by !== undefined && value.byAttribute === false)
		throw new ClientError('@sharded by requires attribute placement', 400);
	if (value.slotFrom !== undefined && (typeof value.slotFrom !== 'string' || !value.slotFrom.trim()))
		throw new ClientError('@sharded slotFrom must be a nonempty expression string', 400);
	if (value.byAttribute !== undefined && typeof value.byAttribute !== 'boolean')
		throw new ClientError('Invalid stored sharding policy: attribute flag must be a boolean', 400);
	return Object.freeze({
		slots: value.slots,
		...(value.by === undefined ? {} : { by: value.by }),
		...(value.slotFrom === undefined ? {} : { slotFrom: value.slotFrom }),
		byAttribute: value.byAttribute ?? value.by !== undefined,
	});
}

export function sameResidencyPolicy(a: ResidencyPolicy | undefined, b: ResidencyPolicy | undefined): boolean {
	return (
		a === b ||
		Boolean(
			a && b && a.slots === b.slots && a.by === b.by && a.slotFrom === b.slotFrom && a.byAttribute === b.byAttribute
		)
	);
}

const keyBuffer = Buffer.allocUnsafeSlow(8192);

export function hashResidencyKey(id: any): number {
	let end: number;
	try {
		end = writeKey(id === 0 ? 0 : id, keyBuffer, 0);
	} catch {
		throw new ClientError('Value cannot be encoded for sharding', 400);
	}
	if (end > 1978) throw new ClientError('Value is too large for sharding slot encoding', 400);
	let hash = 2166136261;
	for (let i = 0; i < end; i++) hash = Math.imul(hash ^ keyBuffer[i], 16777619);
	return hash >>> 0;
}

export function compileResidencyPolicy(policy: ResidencyPolicy): (id: any, record?: any) => number {
	const normalized = normalizeResidencyPolicy(policy);
	const by = normalized.by;
	if (!normalized.slotFrom) {
		if (by)
			return (_id, record) => {
				const value = shardedAttributeValue(record, by);
				if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
					throw new ClientError(`@sharded by attribute ${by} must be a string or finite number`, 400);
				return hashResidencyKey(value) % normalized.slots;
			};
		return (id) => hashResidencyKey(id) % normalized.slots;
	}
	let evaluate: (id: any, record?: any) => unknown;
	try {
		if (normalized.byAttribute) {
			const expression = new Script(
				`(function () { with (this.record) { with (this) { return (${normalized.slotFrom}); } } })`,
				{ filename: 'sharding-slot-expression' }
			).runInThisContext();
			evaluate = (id, record) => expression.call({ id, record: record ?? {} });
		} else {
			evaluate = new Script(`(function (id) { return (${normalized.slotFrom}); })`, {
				filename: 'sharding-slot-expression',
			}).runInThisContext();
		}
	} catch (error) {
		throw new ClientError(`Invalid @sharded slotFrom expression: ${describeSlotValue(error)}`, 400);
	}
	return (id, record) => {
		if (by) shardedAttributeValue(record, by);
		let slot: unknown;
		try {
			slot = evaluate(id, record);
		} catch (error) {
			throw new ClientError(`@sharded slotFrom failed for ${normalized.slots} slots: ${describeSlotValue(error)}`, 400);
		}
		if (slot && (typeof slot === 'object' || typeof slot === 'function')) Promise.resolve(slot).catch(() => {});
		if (!Number.isInteger(slot) || (slot as number) < 0 || (slot as number) >= normalized.slots)
			throw new ClientError(
				`@sharded slotFrom returned ${describeSlotValue(slot)}; expected an integer slot in [0, ${normalized.slots}) for ${normalized.slots} slots`,
				400
			);
		return slot as number;
	};
}

function shardedAttributeValue(record: any, by: string): unknown {
	const value = record?.[by];
	if (value == null) throw new ClientError(`@sharded by attribute ${by} is null or missing`, 400);
	return value;
}

function describeSlotValue(value: unknown): string {
	try {
		return `${typeof value} ${String(value).slice(0, 160)}`;
	} catch {
		return typeof value;
	}
}

export function canonicalShards(value: unknown): number[] | undefined {
	if (value === undefined || value === null) return;
	if (!Array.isArray(value) || value.length === 0 || value.length > 65536)
		throw new ClientError('replication.shards must be a nonempty array of shard IDs', 400);
	const shards = new Set<number>();
	for (const shard of value) {
		if (!Number.isInteger(shard) || shard < 0 || shard > 65535 || shards.has(shard))
			throw new ClientError('replication.shards must contain unique integer shard IDs from 0 to 65535', 400);
		shards.add(shard);
	}
	return [...shards].sort((a, b) => a - b);
}

export function shardListDigest(shards: readonly number[] | undefined): string | null {
	return shards === undefined ? null : createHash('sha256').update(JSON.stringify(shards)).digest('hex');
}

function canonicalRanges(slots: number, ranges: unknown): ResidencyRange[] {
	validateSlotCount(slots);
	if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > slots)
		throw new ClientError('Shard map ranges must cover every slot exactly once', 400);
	const sorted: ResidencyRange[] = ranges
		.map((range) => {
			if (
				!range ||
				!Number.isInteger(range.start) ||
				!Number.isInteger(range.end) ||
				!Number.isInteger(range.shard) ||
				range.start < 0 ||
				range.end > slots ||
				range.start >= range.end ||
				range.shard < 0 ||
				range.shard > 65535
			)
				throw new ClientError('Invalid sharding slot range', 400);
			return { start: range.start, end: range.end, shard: range.shard };
		})
		.sort((a, b) => a.start - b.start);
	const canonical: ResidencyRange[] = [];
	let end = 0;
	for (const range of sorted) {
		if (range.start !== end) throw new ClientError('Shard map has overlapping or missing slots', 400);
		const previous = canonical[canonical.length - 1];
		if (previous?.shard === range.shard) previous.end = range.end;
		else canonical.push(range);
		end = range.end;
	}
	if (end !== slots) throw new ClientError('Shard map does not cover every slot', 400);
	return canonical;
}

export function createResidencyMap(
	database: string,
	slots: number,
	ranges: unknown,
	version = 1
): ResidencyMapSnapshot {
	if (
		typeof database !== 'string' ||
		!database ||
		database.length > commonValidators.schema_length.maximum ||
		database === 'system' ||
		!schemaRegex.test(database) ||
		database.includes('\\') ||
		database === '.' ||
		database === '..'
	)
		throw new ClientError('Shard maps require a non-system database name', 400);
	if (!Number.isSafeInteger(version) || version < 1)
		throw new ClientError('Shard map version must be a positive safe integer', 400);
	const snapshot = { database, version, slots, ranges: canonicalRanges(slots, ranges) };
	return { ...snapshot, digest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}

export function defaultResidencyMap(database: string, slots: number, configured: unknown): ResidencyMapSnapshot {
	validateSlotCount(slots);
	const shards = canonicalShards(configured);
	if (!shards) throw new ClientError('replication.shards is required before installing a default shard map', 503);
	return createResidencyMap(
		database,
		slots,
		Array.from({ length: slots }, (_, slot) => ({
			start: slot,
			end: slot + 1,
			shard: shards[slot % shards.length],
		}))
	);
}

export function validateResidencyMap(value: any, database?: string): ResidencyMapSnapshot {
	if (!value || typeof value !== 'object' || (database !== undefined && value.database !== database))
		throw new ClientError('Shard map database does not match its authorized database', 400);
	const snapshot = createResidencyMap(value.database, value.slots, value.ranges, value.version);
	if (value.digest !== snapshot.digest) throw new ClientError('Shard map digest mismatch', 409);
	return snapshot;
}

export function expandResidencyMap(snapshot: ResidencyMapSnapshot): Uint16Array {
	const shards = new Uint16Array(snapshot.slots);
	for (const range of snapshot.ranges) shards.fill(range.shard, range.start, range.end);
	return shards;
}

/** A later complete snapshot proves compatibility without retaining a map history per record. */
export function residencyMapExtends(older: ResidencyMapSnapshot, newer: ResidencyMapSnapshot): boolean {
	if (older.database !== newer.database || older.version >= newer.version || older.slots > newer.slots) return false;
	const before = expandResidencyMap(older);
	const after = expandResidencyMap(newer);
	return before.every((shard, slot) => shard === after[slot]);
}

export function assertResidencyMapChange(
	previous: ResidencyMapSnapshot | undefined,
	next: ResidencyMapSnapshot,
	activeSlots: number
): void {
	if (!previous || previous.digest === next.digest) return;
	if (previous.version === next.version)
		throw new ClientError(`Conflicting shard map version ${next.version} for ${next.database}`, 409);
	if (next.version < previous.version) throw new ClientError('Cannot replace a newer shard map', 409);
	if (activeSlots && previous.slots !== next.slots)
		throw new ClientError(
			`Shard map slot count ${next.slots} differs from active database count ${previous.slots}`,
			409
		);
	if (activeSlots) {
		const oldShards = expandResidencyMap(previous);
		const newShards = expandResidencyMap(next);
		for (let slot = 0; slot < Math.min(previous.slots, next.slots); slot++) {
			if (oldShards[slot] !== newShards[slot])
				throw new ClientError(`Shard slot ${slot} cannot be reassigned; slot migration is not supported`, 409);
		}
	}
}
