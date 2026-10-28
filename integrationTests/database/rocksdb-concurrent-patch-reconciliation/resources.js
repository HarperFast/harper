import { threadId } from 'node:worker_threads';

export class Probe extends Resource {
	static loadAsInstance = false;
	get() {
		return { threadId };
	}
}

export class Seed extends Resource {
	static loadAsInstance = false;
	async post(_query, { ids }) {
		const seededAt = Date.now();
		for (const id of ids) {
			await tables.Doc.put({ id, title: 'seed', meta: { name: 'seed', n: 0 }, tags: ['seed'], hits: 0 });
		}
		return { seededAt };
	}
}

// An update that never reads meta/tags: it can only change them by applying over a stale base.
export class Updater extends Resource {
	static loadAsInstance = false;
	async post(_query, { id, seq }) {
		const doc = await tables.Doc.update(id);
		doc.addTo('hits', 1);
		doc.title = 'u' + seq;
		return { threadId };
	}
}

export class ReadThenUpdater extends Resource {
	static loadAsInstance = false;
	async post(_query, { id, seq }) {
		await tables.Doc.get(id);
		const doc = await tables.Doc.update(id);
		doc.addTo('hits', 1);
		doc.title = 'u' + seq;
		return { threadId };
	}
}

export class Writer extends Resource {
	static loadAsInstance = false;
	async post(_query, { id, seq }) {
		await tables.Doc.patch(id, { meta: { name: 'w' + seq, n: seq }, tags: ['w' + seq] });
		return { threadId };
	}
}

/**
 * Each record beside the newest writes its audit log holds since the round's seed: `meta`/`tags` must be the
 * highest-version writer's and `title` the highest-version updater's, since each is last-write-wins by
 * version whatever order they committed in.
 */
export class Verify extends Resource {
	static loadAsInstance = false;
	async post(_query, { ids, seededAt }) {
		const Doc = tables.Doc;
		const newest = new Map();
		for (const entry of Doc.auditStore.getRange({ start: seededAt - 1000 })) {
			if (entry.tableId !== Doc.tableId || !ids.includes(entry.recordId)) continue;
			if (entry.type === 'put') {
				newest.set(entry.recordId, { put: entry.version });
				continue;
			}
			const value = entry.type === 'patch' && entry.getValue(Doc.primaryStore);
			const latest = newest.get(entry.recordId);
			if (!value || !latest || entry.version < latest.put) continue;
			const kind = value.meta ? 'writer' : 'updater';
			if (!latest[kind] || entry.version > latest[kind].version) latest[kind] = { version: entry.version, value };
		}
		const docs = [];
		for (const id of ids) {
			const { title, hits, meta, tags } = await Doc.get(id);
			const latest = newest.get(id);
			docs.push({
				id,
				stored: { title, hits, meta, tags },
				newestWriter: latest?.writer?.value,
				newestUpdaterTitle: latest?.updater?.value.title,
			});
		}
		return docs;
	}
}
