// Sources and probes for the harper#2359 suite. `colliding-*` ids get a source payload carrying a
// value under the computed attribute's own name.
const { CachedProduct } = tables;

class ProductOrigin extends Resource {
	get() {
		const id = this.getId();
		const record = { id, price: 100, discount: 40 };
		if (String(id).startsWith('colliding')) record.salePrice = 999;
		return record;
	}
	put() {}
}

CachedProduct.sourcedFrom(ProductOrigin);

// Plants a record the way 5.2.0-5.2.6 stored one: the durable projection disabled for exactly that
// write, so the computed attribute's value becomes a stored field. `validate` rejects a
// user-supplied computed property outright, so no public write path can produce this record.
export class PoisonedRecord extends Resource {
	async put(data) {
		const body = await data;
		const store = CachedProduct.primaryStore;
		const resolvedNames = store.encoder.resolvedAttributeNames;
		try {
			store.encoder.resolvedAttributeNames = undefined;
			await store.put(this.getId(), { id: this.getId(), ...body });
		} finally {
			store.encoder.resolvedAttributeNames = resolvedNames;
		}
	}
}

// Reports whether a record has reached the table's own store, so a test can wait for the cache-fill
// write to commit instead of assuming a re-read is served from storage.
export class StoredState extends Resource {
	get() {
		const id = this.getId();
		const store = String(id).startsWith('item-') ? tables.CachedItem.primaryStore : CachedProduct.primaryStore;
		return { stored: store.getEntry(id) != null };
	}
}

// Reports the keys actually stored for a record, read with the computed accessor and the projection
// removed so that materialization cannot discard a resolver-owned key before it is observed. This is
// the only way to see the durable bytes: every ordinary read path drops such a key on the way out.
export class StoredKeys extends Resource {
	get() {
		const store = CachedProduct.primaryStore;
		const prototype = store.encoder.structPrototype;
		const descriptor = Object.getOwnPropertyDescriptor(prototype, 'salePrice');
		const resolved = store.encoder.resolvedAttributeNames;
		try {
			delete prototype.salePrice;
			store.encoder.resolvedAttributeNames = undefined;
			const id = this.getId();
			// A range read rather than a point read: the point read is served from the record cache, whose
			// entry is the already-materialized record.
			const [entry] = store.getRange({ start: id, end: `${id}￿` }).asArray;
			return { keys: entry?.value ? Object.keys(entry.value) : null };
		} finally {
			if (descriptor) Object.defineProperty(prototype, 'salePrice', descriptor);
			store.encoder.resolvedAttributeNames = resolved;
		}
	}
}

// PlainProduct has no source, so invalidation is reached explicitly here.
export class PlainProductResource extends tables.PlainProduct {
	static async post(target) {
		await this.invalidate(target);
		return { status: 'invalidated' };
	}
}

// Plants a record with a stored value under an @enumerable relationship name, as an affected release
// could have done through the same response projection.
export class PoisonedRelationship extends Resource {
	async put(data) {
		const body = await data;
		await tables.Item.primaryStore.put(this.getId(), { id: this.getId(), ...body });
	}
}

// Raw stored keys for Item, read with the relationship accessor removed so materialization cannot
// discard or re-derive anything before it is observed.
export class ItemKeys extends Resource {
	get() {
		const store = tables.Item.primaryStore;
		const prototype = store.encoder.structPrototype;
		const descriptor = Object.getOwnPropertyDescriptor(prototype, 'cat');
		const resolved = store.encoder.resolvedAttributeNames;
		try {
			delete prototype.cat;
			store.encoder.resolvedAttributeNames = undefined;
			const id = this.getId();
			const [entry] = store.getRange({ start: id, end: `${id}￿` }).asArray;
			return { keys: entry?.value ? Object.keys(entry.value) : null, cat: entry?.value?.cat ?? null };
		} finally {
			if (descriptor) Object.defineProperty(prototype, 'cat', descriptor);
			store.encoder.resolvedAttributeNames = resolved;
		}
	}
}

class CachedItemOrigin extends Resource {
	get() {
		const id = this.getId();
		// relobj-* ids return the related object instead of the foreign key
		if (String(id).startsWith('item-relobj')) return { id, label: 'from source', cat: { slug: 'a', name: 'A' } };
		// malformed relationship shapes alongside a good foreign key: derivation must not wipe it
		if (String(id).startsWith('item-relscalar')) return { id, label: 'from source', catId: 'a', cat: 'a' };
		if (String(id).startsWith('item-relnopk')) return { id, label: 'from source', catId: 'a', cat: { name: 'A' } };
		return { id, label: 'from source', catId: 'no-such-cat' };
	}
	put() {}
}
tables.CachedItem.sourcedFrom(CachedItemOrigin);

// The Item-table variant of RangeScan: a stored value under the writable `cat` relationship must
// neither crash materialization (stored null) nor rewrite the foreign key (stored scalar) on the
// store's own getRange path.
export class RangeScanItem extends Resource {
	get() {
		const id = this.getId();
		const [entry] = tables.Item.primaryStore.getRange({ start: id, end: `${id}￿` }).asArray;
		return entry?.value ? { catId: entry.value.catId, ownKeys: Object.keys(entry.value) } : null;
	}
}
