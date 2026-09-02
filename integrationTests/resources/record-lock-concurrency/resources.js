// Record-lock concurrency fixture (harper#483, Phase 0).
//
// POST /LockedIncrement/ { id, timeout?, mode? }
//   Under `tables.Counter.lock(id)` (transaction-scoped): read n, write n + 1, commit. Responds with
//   the holder interval [start, end] (start after the lock committed, end before the commit that
//   releases it) and the worker thread that served it.
//   mode: 'worker-mutex' replaces the record lock with a per-worker async mutex — the control that
//   proves the assertions can fail: each worker admits one holder at a time, but the workers do not
//   see each other, so holders overlap across threads and increments are lost.
// POST /LockHold/ { id, lease } — take a held lock ({ hold: true }) and return without releasing it;
//   only its lease ends it (the abandoned-holder case).
import { threadId } from 'node:worker_threads';

let workerMutex = Promise.resolve();
function withWorkerMutex(fn) {
	const run = workerMutex.then(fn, fn);
	workerMutex = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

export class LockedIncrement extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const id = body?.id ?? 'default';
		const mode = body?.mode ?? 'record-lock';
		const timeout = body?.timeout;
		if (mode === 'worker-mutex') {
			return withWorkerMutex(async () => {
				const start = Date.now();
				const current = (await tables.Counter.get(id))?.n ?? 0;
				await tables.Counter.put({ id, n: current + 1 });
				return { id, start, end: Date.now(), worker: threadId, mode };
			});
		}
		const record = await tables.Counter.lock(id, timeout ? { timeout } : undefined);
		const start = Date.now();
		record.set('n', (record.getProperty('n') ?? 0) + 1);
		await record.save();
		return { id, start, end: Date.now(), worker: threadId, mode };
	}
}

export class LockHold extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const id = body?.id ?? 'default';
		const record = await tables.Counter.lock(id, { hold: true, lease: body?.lease ?? 2000 });
		return {
			id,
			worker: threadId,
			n: record.getProperty('n'),
		};
	}
}
