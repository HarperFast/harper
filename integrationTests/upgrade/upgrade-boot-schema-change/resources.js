// QA-647 (source: gh:1865) — upgrade-boot read-visibility fixture.
//
// Widget is a component-defined table (schema.graphql), matching #1865's specific claim that
// the miss is on COMPONENT tables. Endpoints below exercise the read surfaces the investigation
// needs, in-process, so a restart-induced miss on one surface can be checked against an
// independent oracle rather than judged by itself.
//
//   POST /Load/  { count, batch }        — seed rows via the in-process write path.
//   GET  /PointGet/?id=X                 — cached point-GET: in-process table.get(id), the
//     Resource/table-level primary-key lookup — the surface #1865 reports missing rows on.
//   GET  /ScanAll/[?batch=X]             — uncached, INDEX-INDEPENDENT full base-store scan.
//     The oracle: proves a row is physically on disk regardless of any cache or secondary-index
//     state. Do not let PointGet or the REST/ops surfaces judge themselves — always compare
//     against this.
//   POST /Touch/ { id, sku, batch, name } — write-then-read heal probe: re-put the row with its
//     known original fields (works even if the row currently reads as missing), then re-run
//     PointGet, so a single call answers "does a write repair the miss".

function getTable() {
	return databases['qa647']['Widget'];
}

function qp(query, name, def) {
	const v = query && (query.get ? query.get(name) : query[name]);
	return v == null ? def : v;
}

export class Load extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const count = Number(b.count) || 0;
		const batch = b.batch || 'default';
		const table = getTable();
		const ids = [];
		for (let i = 0; i < count; i++) {
			const id = `w-${batch}-${i}`;
			await table.put({ id, sku: `SKU-${batch}-${i}`, batch, name: `Widget ${batch} ${i}` });
			ids.push(id);
		}
		return { ok: true, count, batch, ids };
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

export class ScanAll extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const batch = qp(query, 'batch', null);
		const table = getTable();
		const ids = [];
		for await (const r of table.search({ conditions: [] })) {
			if (batch == null || r.batch === batch) ids.push(r.id);
		}
		return { count: ids.length, ids: ids.sort() };
	}
}

export class Touch extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const { id, sku, batch, name } = b;
		if (!id) throw new Error('Touch requires id');
		const table = getTable();
		await table.put({ id, sku, batch, name, touched: Date.now() });
		const after = await table.get(id);
		return { ok: true, id, foundAfterTouch: after != null };
	}
}
