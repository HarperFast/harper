// QA-269 — addTo write surface for TTL reset test.
// POST /AddToCounter/ { id, delta } — atomically addTo n by delta.

export class AddToCounter extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const id = (body && body.id) || 'k';
		const delta = (body && body.delta !== undefined) ? Number(body.delta) : 1;
		const updatable = await tables.Expiry.update(id, {});
		updatable.set('id', id);
		updatable.addTo('n', delta);
		await updatable.save();
		return { ok: true };
	}
}
