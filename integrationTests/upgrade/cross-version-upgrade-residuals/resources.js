// QA-660 (#1865 residual, source QA-658/P-437) — cross-version upgrade-boot read-visibility
// fixture, extended for scale + width-heterogeneity + bulk-capable read surfaces (per-id HTTP
// round trips do not scale to 50k+ rows).
//
//   POST /Load/       { count, batch, startIndex, concurrency } — seeds WIDTH-HETEROGENEOUS rows
//     concurrently (a worker pool of unawaited table.put() calls, not a serial loop), so a
//     SIGKILL sent mid-call has a real externally-timeable window to land mid-write.
//   GET  /LoadStatus/?batch=X                                   — in-memory progress counter for
//     the CURRENTLY RUNNING Load call (polled by the test to fire a SIGKILL genuinely mid-write,
//     and to detect the concurrent-writes-across-boot-boundary race).
//   GET  /ScanAll/                                               — uncached, INDEX-INDEPENDENT
//     full base-store scan. THE ORACLE: proves a row is physically on disk regardless of any
//     cache/secondary-index state. Returns {id, batch} pairs so the test can partition by batch
//     from a single scan pass.
//   POST /PointGetBulk/ { ids: [...] }                           — cached point-GET surface,
//     batched at the TRANSPORT layer only: server-side loop of the same table.get(id) call the
//     single-id /PointGet/ used, so the read semantics under test are unchanged.
//   GET  /PointGet/?id=X                                         — single-id cached point-GET
//     (kept for parity/spot checks).
//   POST /Touch/ <row>                                           — write-then-read heal probe;
//     accepts any row shape (width-heterogeneous rows carry different field sets).
//
// Widget is a component-defined table (schema.graphql) with a FIXED declared field set (id/sku/
// batch/name) but rows carry additional UNDECLARED fields to build a non-trivial typed-struct
// dictionary (#1865's suspected mechanism) — Harper's document-store tables accept additional
// properties beyond the declared schema.

function getTable() {
	return databases['qa660']['Widget'];
}

function qp(query, name, def) {
	const v = query && (query.get ? query.get(name) : query[name]);
	return v == null ? def : v;
}

/**
 * Width-heterogeneous, type-heterogeneous extra-field generator. Six disjoint shapes (narrow,
 * arrays, long strings, nested objects, mixed scalars, unicode) cycling by index so the seeded
 * dataset is NOT uniform-width — the point of arm (a) in QA-660.
 */
function hetExtra(idx) {
	const shape = idx % 6;
	switch (shape) {
		case 0:
			return {}; // narrow: only the declared fields
		case 1:
			return { tags: [`t${idx % 7}`, `t${idx % 11}`, `t${idx % 13}`], weight: idx * 1.5 };
		case 2:
			return { description: 'd'.repeat(64 + (idx % 200)), score: idx % 997 };
		case 3:
			return { meta: { a: idx, b: `${idx}`, nested: { deep: idx % 13, flag: idx % 2 === 0 } } };
		case 4:
			return {
				extra1: idx,
				extra2: `v${idx}`,
				extra3: [idx, idx + 1, idx + 2],
				extra4: idx % 2 === 0,
				extra5: 'y'.repeat(40 + (idx % 80)),
				extra6: idx * 0.001,
			};
		default:
			return { label: 'L'.repeat(300), unicode: '标签-' + (idx % 50), gauge: Math.PI * (1 + (idx % 97)) };
	}
}

function makeRow(batch, idx) {
	const id = `w-${batch}-${idx}`;
	return { id, sku: `SKU-${batch}-${idx}`, batch, name: `Widget ${batch} ${idx}`, ...hetExtra(idx) };
}

export class Load extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const count = Number(b.count) || 0;
		const batch = b.batch || 'default';
		const startIndex = Number(b.startIndex) || 0;
		const concurrency = Math.max(1, Number(b.concurrency) || 100);
		const table = getTable();
		globalThis.__loadProgress = globalThis.__loadProgress || {};
		globalThis.__loadProgress[batch] = 0;
		let idx = startIndex;
		const end = startIndex + count;
		const ids = [];
		let completed = 0;
		async function worker() {
			for (;;) {
				const i = idx++;
				if (i >= end) return;
				const row = makeRow(batch, i);
				await table.put(row);
				ids.push(row.id);
				completed++;
				globalThis.__loadProgress[batch] = completed;
			}
		}
		await Promise.all(Array.from({ length: concurrency }, () => worker()));
		return { ok: true, count, batch, completed, ids };
	}
}

export class LoadStatus extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const batch = qp(query, 'batch', 'default');
		const completed = (globalThis.__loadProgress && globalThis.__loadProgress[batch]) || 0;
		return { batch, completed };
	}
}

export class PointGet extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const id = qp(query, 'id');
		const table = getTable();
		const rec = await table.get(id);
		return { id, found: rec != null, record: rec ?? null };
	}
}

export class PointGetBulk extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const ids = Array.isArray(b.ids) ? b.ids : [];
		const table = getTable();
		const misses = [];
		let hits = 0;
		for (const id of ids) {
			const rec = await table.get(id);
			if (rec != null) hits++;
			else misses.push(id);
		}
		return { requested: ids.length, hits, misses };
	}
}

export class ScanAll extends Resource {
	static loadAsInstance = false;
	async get() {
		const table = getTable();
		const rows = [];
		for await (const r of table.search({ conditions: [] })) {
			rows.push({ id: r.id, batch: r.batch });
		}
		rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		return { count: rows.length, rows };
	}
}

export class Touch extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const row = body || query || {};
		if (!row.id) throw new Error('Touch requires id');
		const table = getTable();
		await table.put({ ...row, touched: Date.now() });
		const after = await table.get(row.id);
		return { ok: true, id: row.id, foundAfterTouch: after != null };
	}
}
