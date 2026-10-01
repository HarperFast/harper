// put() exists only because a DIRECT write to a cache-sourced table is rejected with 405 without
// one, and the Q0 control needs that write.
const { Item, Source, Counter } = tables;

Item.sourcedFrom(
	class extends Resource {
		async get() {
			const id = String(this.getId());
			const src = await Source.get(id);
			const cur = await Counter.get(id);
			// SourceContext.replacingRecord holds the record this resolution replaces, so it is present
			// exactly when the read revalidated a RESIDENT entry and absent when it filled an absent
			// one. Recording it is how the test proves which of the two branches its GET took.
			const replaced = this.getContext?.()?.replacingRecord;
			await Counter.put({ id, count: (cur?.count ?? 0) + 1, replacedValue: replaced?.value ?? null });
			if (!src) return null;
			return { id, value: src.value, nonce: src.nonce };
		}
		async put() {}
	}
);

/** Reads the stored entry without resolving it, so observing the row cannot itself refill it. */
export class ItemRaw extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const id = query && typeof query.get === 'function' ? query.get('id') : query?.id;
		const entry = Item.primaryStore.getEntry(id);
		if (entry == null) return { exists: false, value: null, expiresAt: null };
		return { exists: true, value: entry.value, expiresAt: entry.expiresAt ?? null };
	}
}
