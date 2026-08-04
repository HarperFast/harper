// F-147 / #1854 — aborted delete on an audit:false @indexed table must roll back.
//
// POST /DeleteAndAbort/ { id }
//   Deletes the row, then throws — forcing the ambient request transaction to abort.
//   If removeEntry() is properly transactional, both the base row and its secondary-index
//   entry must survive the abort.
//
// POST /DeleteAndCommit/ { id }
//   Deletes the row and returns normally (no throw) — the regression guard confirming the
//   fix didn't break an ordinary committed delete.

export class DeleteAndAbort extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		await tables.Item.delete(b.id);
		throw new Error(`F-147 forced throw after Item(${b.id}) delete`);
	}
}

export class DeleteAndCommit extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		await tables.Item.delete(b.id);
		return { ok: true, id: b.id };
	}
}
