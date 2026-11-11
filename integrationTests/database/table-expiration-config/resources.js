// POST /TtlControl/ drives table-expiration-config.test.ts:
//   { op: 'declare', table, expiration?, eviction?, avoidWorker?, onWorker? } — defineTable on the worker that
//     serves the request; a worker that avoidWorker excludes, or onWorker does not name, answers { wrongThread }
//     and the test retries on a fresh connection, so the scan owner only ever learns the TTL from the catalog
//   { op: 'ttl', table, onWorker } — that worker's view of the table: whether it is loaded, and its TTL in ms
//   { op: 'write', table, count, expiresInMs } — rows whose own expiry is expiresInMs from now
import { Resource, databases, defineTable, types } from 'harper';
import { workerData } from 'node:worker_threads';

const DATABASE = 'ttl_config';
const workerIndex = () => workerData?.workerIndex ?? 0;

export class TtlControl extends Resource {
	static loadAsInstance = false;
	async post(_target, body) {
		const { op, table } = body;
		if (op === 'declare') {
			if (
				(body.avoidWorker !== undefined && workerIndex() === body.avoidWorker) ||
				(body.onWorker !== undefined && workerIndex() !== body.onWorker)
			)
				return { wrongThread: true, workerIndex: workerIndex() };
			const options = { database: DATABASE };
			if (body.expiration !== undefined) options.expiration = body.expiration;
			if (body.eviction !== undefined) options.eviction = body.eviction;
			defineTable(table, { id: types.id.primaryKey, value: types.string.nullable }, options);
			return { workerIndex: workerIndex() };
		}
		if (op === 'ttl') {
			if (workerIndex() !== body.onWorker) return { wrongThread: true, workerIndex: workerIndex() };
			const Table = databases[DATABASE]?.[table];
			return {
				workerIndex: workerIndex(),
				loaded: Boolean(Table),
				expirationMS: Table?.expirationMS || 0,
				evictionMS: Table?.evictionMS || 0,
			};
		}
		if (op === 'write') {
			const Table = databases[DATABASE][table];
			const expiresAt = Date.now() + body.expiresInMs;
			for (let i = 0; i < body.count; i++) await Table.put(String(i), { id: String(i), value: 'v' }, { expiresAt });
			return { workerIndex: workerIndex(), expiresAt };
		}
		throw new Error(`unknown op ${op}`);
	}
}
