import { threadId } from 'node:worker_threads';

const { Counter } = tables;

export class Increment extends Resource {
	static loadAsInstance = false;

	async post(_target, { ids, mode }) {
		for (const id of ids) {
			const record = await Counter.update(id);
			if (mode === 'set') record.set('count', record.count + 1);
			else record.addTo('count', 1);
		}
		// Commit here rather than after return so the native handle's retry count is final; both
		// conflict-retry paths in DatabaseTransaction.commit() bump it and keep the same handle. LMDB has no
		// such handle, so it reports null rather than a misleading 0.
		const transaction = this.getContext().transaction;
		const handle = transaction.transaction;
		await transaction.commit();
		return { thread: threadId, retries: handle ? (handle.retries ?? 0) : null };
	}
}

export class Seed extends Resource {
	static loadAsInstance = false;

	async post(_target, { start, count }) {
		for (let id = start; id < start + count; id++) await Counter.put({ id, count: 0 });
		return { ok: true };
	}
}

export class Counts extends Resource {
	static loadAsInstance = false;

	async post(_target, { ids }) {
		const counts = [];
		for (const id of ids) counts.push((await Counter.get(id))?.count ?? null);
		return counts;
	}
}
