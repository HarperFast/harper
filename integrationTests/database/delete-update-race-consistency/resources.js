// QA-349 — DELETE vs concurrent UPDATE race resources.
//
// RaceOp: fire DELETE and a write op concurrently against the same Widget key.
//   POST /RaceOp/ {key, op: 'patch'|'put'|'addTo'|'delete'|'recreate', value, delta}
//   -> { deleted, outcome }
//
// Used internally to fire concurrent races without relying on two separate HTTP calls
// having the exact same wall-clock arrival. The concurrent pair is fired from within
// a single server-side async race, so they hit the same worker (or cross-worker via
// normal Harper dispatch) with minimal network jitter.

export class RaceOp extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const key = body.key;
		const op = body.op;

		// Always ensure the record exists before the race
		await tables.Widget.put({ id: key, value: 'seed', counter: 0, category: 'seed' });

		let deleteResult = null;
		let writeResult = null;
		let deleteError = null;
		let writeError = null;

		if (op === 'delete-delete') {
			// (e) Two concurrent DELETEs
			const [r1, r2] = await Promise.allSettled([
				tables.Widget.delete(key),
				tables.Widget.delete(key),
			]);
			deleteResult = r1.status === 'fulfilled' ? 'ok' : r1.reason?.message;
			writeResult  = r2.status === 'fulfilled' ? 'ok' : r2.reason?.message;
			return { op, key, del1: deleteResult, del2: writeResult };
		}

		// Fire DELETE + write concurrently
		const [delP, writeP] = await Promise.allSettled([
			tables.Widget.delete(key),
			(async () => {
				if (op === 'patch') {
					return tables.Widget.patch(key, { value: body.value ?? 'patched', category: 'patched' });
				} else if (op === 'put') {
					return tables.Widget.put({ id: key, value: body.value ?? 'put', counter: 1, category: 'put' });
				} else if (op === 'addTo') {
					return tables.Widget.update(key, { counter: { addTo: body.delta ?? 5 } });
				} else if (op === 'recreate') {
					// DELETE already racing; we try create
					return tables.Widget.create({ id: key, value: 'recreated', counter: 99, category: 'recreated' });
				}
			})(),
		]);

		deleteError = delP.status === 'rejected' ? delP.reason?.message : null;
		writeError  = writeP.status === 'rejected' ? writeP.reason?.message : null;

		return {
			op,
			key,
			deleteOk: delP.status === 'fulfilled',
			writeOk:  writeP.status === 'fulfilled',
			deleteError,
			writeError,
		};
	}
}
