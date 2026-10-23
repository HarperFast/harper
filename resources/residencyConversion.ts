import { setImmediate } from 'node:timers/promises';
import { server } from '../server/Server.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import {
	compileResidencyPolicy,
	expandResidencyMap,
	normalizeResidencyPolicy,
	validateResidencyMap,
} from './residencyPolicy.ts';

/** Read-only comparison on the application thread that owns the actual legacy function. */
export async function compareResidencyPlacement(Table: any, policy: unknown, snapshot: unknown) {
	if (Table.residency) throw new ClientError('The table already has a declarative residency policy', 409);
	const legacy = Table.getResidencyById;
	if (typeof legacy !== 'function')
		throw new ClientError('Run the residency comparison on an application thread with setResidencyById installed', 409);
	const proposed = normalizeResidencyPolicy(policy);
	if (proposed.byAttribute)
		throw new ClientError('Online residency conversion supports key-derived policies only', 400);
	const map = validateResidencyMap(snapshot, Table.databaseName);
	if (map.slots < proposed.slots) throw new ClientError('The installed map does not cover the proposed slots', 400);
	const shards = expandResidencyMap(map);
	const slotFor = compileResidencyPolicy(proposed);
	const coverage = new Set<number>();
	const departed = new Set<string>();
	const known = new Set([server.hostname, ...(server.nodes ?? []).map((node) => node.name)]);
	const inspectedLists = new Set<number>();
	let checked = 0,
		mismatches = 0;
	const samples = [];
	for (const entry of Table.primaryStore.getRange({ start: true, snapshot: false })) {
		if (entry.value == null) continue;
		const slot = slotFor(entry.key);
		const previousShard = legacy(entry.key);
		if (!Number.isInteger(previousShard) || previousShard < 0 || previousShard > 65535)
			throw new ClientError('The legacy setResidencyById function must return a numeric shard ID for every key', 400);
		coverage.add(slot);
		if (previousShard !== shards[slot]) {
			mismatches++;
			if (samples.length < 25) samples.push({ id: entry.key, previousShard, proposedShard: shards[slot], slot });
		}
		if (entry.residencyId && !inspectedLists.has(entry.residencyId)) {
			inspectedLists.add(entry.residencyId);
			for (const name of Table.getResidencyRecord(entry.residencyId) ?? []) if (!known.has(name)) departed.add(name);
		}
		if (++checked % 256 === 0) await setImmediate();
	}
	return {
		database: Table.databaseName,
		table: Table.tableName,
		mapVersion: map.version,
		mapDigest: map.digest,
		checked,
		mismatches,
		samples,
		observedSlots: [...coverage].sort((a, b) => a - b),
		departedNodeNames: [...departed].sort(),
	};
}
