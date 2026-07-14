// QA-431 — sub-second-TTL atomic counter resource.
//
// POST /RateIncrement/ { id } → atomically addTo('hits', 1) on RateCounter[id].
// No prior record required — update() upserts from scratch (count starts at 0+1=1).
// Returns { ok, id } on 200; throws propagate as 500.

export class RateIncrement extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const id = (body && body.id) || 'default';
		const updatable = await tables.RateCounter.update(id, {});
		updatable.set('id', id);
		updatable.addTo('hits', 1);
		await updatable.save();
		return { ok: true, id };
	}
}
