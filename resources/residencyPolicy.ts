import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { writeKey } from 'ordered-binary';
import { ClientError } from '../utility/errors/hdbError.ts';
import { commonValidators, schemaRegex } from '../validation/common_validators.ts';

export interface ResidencyPolicy {
	slots: number;
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

function validateSlotCount(slots: unknown): asserts slots is number {
	if (!Number.isInteger(slots) || (slots as number) < 1 || (slots as number) > 65536)
		throw new ClientError('@residency slots must be an integer from 1 to 65536', 400);
}

export function normalizeResidencyPolicy(value: any): Readonly<ResidencyPolicy> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new ClientError('@residency requires a policy object', 400);
	for (const key of Object.keys(value))
		if (!['slots', 'slotFrom', 'byAttribute'].includes(key))
			throw new ClientError(`Unknown @residency argument ${key}`, 400);
	validateSlotCount(value.slots);
	if (value.slotFrom !== undefined && (typeof value.slotFrom !== 'string' || !value.slotFrom.trim()))
		throw new ClientError('@residency slotFrom must be a nonempty expression string', 400);
	if (value.byAttribute !== undefined && typeof value.byAttribute !== 'boolean')
		throw new ClientError('@residency byAttribute must be a boolean', 400);
	return Object.freeze({
		slots: value.slots,
		...(value.slotFrom === undefined ? {} : { slotFrom: value.slotFrom }),
		byAttribute: value.byAttribute ?? false,
	});
}

export function sameResidencyPolicy(a: ResidencyPolicy | undefined, b: ResidencyPolicy | undefined): boolean {
	return (
		a === b || Boolean(a && b && a.slots === b.slots && a.slotFrom === b.slotFrom && a.byAttribute === b.byAttribute)
	);
}

const keyBuffer = Buffer.allocUnsafeSlow(8192);

export function hashResidencyKey(id: any): number {
	const end = writeKey(id, keyBuffer, 0);
	if (end > 1978) throw new ClientError('Primary key is too large for residency slot encoding', 400);
	let hash = 2166136261;
	for (let i = 0; i < end; i++) hash = Math.imul(hash ^ keyBuffer[i], 16777619);
	return hash >>> 0;
}

export function compileResidencyPolicy(policy: ResidencyPolicy): (id: any, record?: any) => number {
	const normalized = normalizeResidencyPolicy(policy);
	if (!normalized.slotFrom) return (id) => hashResidencyKey(id) % normalized.slots;
	let evaluate: (id: any, record?: any) => unknown;
	try {
		if (normalized.byAttribute) {
			const expression = new Script(
				`(function () { with (this.record) { with (this) { return (${normalized.slotFrom}); } } })`,
				{ filename: 'residency-slot-expression' }
			).runInThisContext();
			evaluate = (id, record) => expression.call({ id, record: record ?? {} });
		} else {
			evaluate = new Script(`(function (id) { return (${normalized.slotFrom}); })`, {
				filename: 'residency-slot-expression',
			}).runInThisContext();
		}
	} catch (error) {
		throw new ClientError(`Invalid @residency slotFrom expression: ${error.message}`, 400);
	}
	return (id, record) => {
		let slot: unknown;
		try {
			slot = evaluate(id, record);
		} catch (error) {
			throw new ClientError(`@residency slotFrom failed: ${error.message}`, 400);
		}
		if (slot && typeof (slot as any).then === 'function') Promise.resolve(slot).catch(() => {});
		if (!Number.isInteger(slot) || (slot as number) < 0 || (slot as number) >= normalized.slots)
			throw new ClientError(`@residency slotFrom must return an integer slot from 0 to ${normalized.slots - 1}`, 400);
		return slot as number;
	};
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
		throw new ClientError('Residency map ranges must cover every slot exactly once', 400);
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
				throw new ClientError('Invalid residency slot range', 400);
			return { start: range.start, end: range.end, shard: range.shard };
		})
		.sort((a, b) => a.start - b.start);
	const canonical: ResidencyRange[] = [];
	let end = 0;
	for (const range of sorted) {
		if (range.start !== end) throw new ClientError('Residency map has overlapping or missing slots', 400);
		const previous = canonical[canonical.length - 1];
		if (previous?.shard === range.shard) previous.end = range.end;
		else canonical.push(range);
		end = range.end;
	}
	if (end !== slots) throw new ClientError('Residency map does not cover every slot', 400);
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
		throw new ClientError('Residency maps require a non-system database name', 400);
	if (!Number.isSafeInteger(version) || version < 1)
		throw new ClientError('Residency map version must be a positive safe integer', 400);
	const snapshot = { database, version, slots, ranges: canonicalRanges(slots, ranges) };
	return { ...snapshot, digest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}

export function defaultResidencyMap(database: string, slots: number, configured: unknown): ResidencyMapSnapshot {
	validateSlotCount(slots);
	const shards = canonicalShards(configured);
	if (!shards) throw new ClientError('replication.shards is required before installing a default residency map', 503);
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
		throw new ClientError('Residency map database does not match its authorized database', 400);
	const snapshot = createResidencyMap(value.database, value.slots, value.ranges, value.version);
	if (value.digest !== snapshot.digest) throw new ClientError('Residency map digest mismatch', 409);
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
		throw new ClientError(`Conflicting residency map version ${next.version} for ${next.database}`, 409);
	if (next.version < previous.version) throw new ClientError('Cannot replace a newer residency map', 409);
	if (activeSlots > next.slots) throw new ClientError('Residency map would remove active slots', 409);
	if (activeSlots) {
		const oldShards = expandResidencyMap(previous);
		const newShards = expandResidencyMap(next);
		for (let slot = 0; slot < Math.min(previous.slots, next.slots); slot++) {
			if (oldShards[slot] !== newShards[slot])
				throw new ClientError(`Residency slot ${slot} cannot be reassigned; slot migration is not supported`, 409);
		}
	}
}
