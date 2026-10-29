const { CachedRow } = tables;
let loads = 0;

class RowOrigin extends Resource {
	get() {
		loads++;
		const id = this.getId();
		return { id, body: `fresh ${id}`, rank: 0 };
	}
	put() {}
}
CachedRow.sourcedFrom(RowOrigin);

// POST /InvalidateRow/ { id } -> the public invalidate API, committed with this request
export class InvalidateRow extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		await CachedRow.invalidate(body.id);
		return { ok: true };
	}
}

// GET /RowState/<id> -> how many source loads ran, and what the table's own store holds for the id
export class RowState extends Resource {
	static loadAsInstance = false;
	get(target) {
		const entry = CachedRow.primaryStore.getEntry(target.id);
		return { loads, exists: entry != null, hasRecord: entry?.value != null };
	}
}
