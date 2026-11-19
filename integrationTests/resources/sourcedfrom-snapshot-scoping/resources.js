// QA-596 — force a genuinely async gap (real timer, real event-loop yield) mid-resolver-fill,
// straddling a concurrent commit, and see whether the assembled view still comes from one
// consistent snapshot. Two shapes: single-store (SingleTableSnap over Cell) and cross-store
// (CrossTableSnap over RowA + RowB).
import { setTimeout as sleep } from 'node:timers/promises';
import { threadId } from 'node:worker_threads';

const { Cell, RowA, RowC, SingleTableSnap, CrossTableSnap, TwoTableSameDbSnap } = tables;
// RowB lives in a SEPARATE Harper database ("qa596b", see schema.graphql) so it gets its own
// RocksDB root store -- a genuine cross-store boundary, unlike RowA which shares the default
// database's store with Cell (same rootStore.path => same txnForContext chain link).
const RowB = databases.qa596b.RowB;

let gapMs = 100;
let fillCounter = 0;
const fillLog = [];

SingleTableSnap.sourcedFrom(
	class extends Resource {
		async get() {
			const entityId = String(this.getId());
			const fillSeq = ++fillCounter;
			const startedAt = Date.now();
			const first = await Cell.get(`${entityId}:slotA`);
			// genuinely async: a real timer, a real macrotask yield -- not just a microtask hop
			await sleep(gapMs);
			const second = await Cell.get(`${entityId}:slotB`);
			const finishedAt = Date.now();
			const result = {
				id: entityId,
				gens: { slotA: first ? first.gen : null, slotB: second ? second.gen : null },
				fillSeq,
				assembledAt: finishedAt,
			};
			fillLog.push({ kind: 'single', entityId, fillSeq, startedAt, finishedAt, threadId, result });
			return result;
		}
	}
);

CrossTableSnap.sourcedFrom(
	class extends Resource {
		async get() {
			const entityId = String(this.getId());
			const fillSeq = ++fillCounter;
			const startedAt = Date.now();
			const a = await RowA.get(entityId);
			const preGapAt = Date.now(); // RowA read done, about to yield for the real gap
			// genuinely async gap BETWEEN reading two different tables/stores
			await sleep(gapMs);
			const postGapAt = Date.now(); // gap elapsed, about to touch RowB's store for the FIRST time
			const b = await RowB.get(entityId);
			const finishedAt = Date.now();
			const result = {
				id: entityId,
				genA: a ? a.gen : null,
				genB: b ? b.gen : null,
				fillSeq,
				startedAt,
				preGapAt,
				postGapAt,
				finishedAt,
				assembledAt: finishedAt,
			};
			fillLog.push({ kind: 'cross', entityId, fillSeq, startedAt, finishedAt, threadId, result });
			return result;
		}
	}
);

TwoTableSameDbSnap.sourcedFrom(
	class extends Resource {
		async get() {
			const entityId = String(this.getId());
			const fillSeq = ++fillCounter;
			const startedAt = Date.now();
			const a = await RowA.get(entityId);
			// genuinely async gap between two DIFFERENT tables that share the SAME database/rootStore
			await sleep(gapMs);
			const c = await RowC.get(entityId);
			const finishedAt = Date.now();
			const result = {
				id: entityId,
				genA: a ? a.gen : null,
				genC: c ? c.gen : null,
				fillSeq,
				assembledAt: finishedAt,
			};
			fillLog.push({ kind: 'two-table-same-db', entityId, fillSeq, startedAt, finishedAt, threadId, result });
			return result;
		}
	}
);

/** POST { gapMs } — set/clear the artificial real-timer gap inside both resolvers' get(). */
export class Control extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		if (typeof body?.gapMs === 'number') gapMs = body.gapMs;
		return { ok: true, gapMs, threadId };
	}
}

/** GET /FillLog/ — every fill this worker has run (which worker, timing, and its own result). */
export class FillLog extends Resource {
	static loadAsInstance = false;
	async get() {
		return fillLog;
	}
}

/** GET /WhoAmI/ — this worker's threadId (process.pid is identical across worker_threads). */
export class WhoAmI extends Resource {
	static loadAsInstance = false;
	async get() {
		return { threadId };
	}
}

/** GET /CellScan/?id=S1 — independent oracle: raw Cell rows for one entity, bypassing SingleTableSnap. */
export class CellScan extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const id = query && typeof query.get === 'function' ? query.get('id') : query?.id;
		const a = await Cell.get(`${id}:slotA`);
		const b = await Cell.get(`${id}:slotB`);
		return { slotA: a ? a.gen : null, slotB: b ? b.gen : null };
	}
}

/** GET /RowScan/?id=C1 — independent oracle: raw RowA/RowB for one entity, bypassing CrossTableSnap. */
export class RowScan extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const id = query && typeof query.get === 'function' ? query.get('id') : query?.id;
		const a = await RowA.get(id);
		const b = await RowB.get(id);
		return { genA: a ? a.gen : null, genB: b ? b.gen : null };
	}
}
