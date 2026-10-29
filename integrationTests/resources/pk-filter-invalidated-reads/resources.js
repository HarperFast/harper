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

export class InvalidateRow extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		await CachedRow.invalidate(body.id);
		return { ok: true };
	}
}

export class RowState extends Resource {
	static loadAsInstance = false;
	get(target) {
		const entry = CachedRow.primaryStore.getEntry(target.id);
		return { loads, exists: entry != null, hasRecord: entry?.value != null };
	}
}
