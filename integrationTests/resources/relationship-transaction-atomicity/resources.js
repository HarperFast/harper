// QA-162 — Cross-table transaction + @relationship edge atomicity.
//
// Three custom endpoints:
//
//   POST /CreateOrderWithItem/
//     { orderId, itemId, name, price, fail }
//     Writes Order (parent), then OrderItem (child). If fail=true, throws AFTER writing
//     Order but BEFORE writing OrderItem. Tests:
//       - fail=false: both rows committed, edge resolves in both directions.
//       - fail=true:  Order must roll back (no dangling parent), FK index must be clean.
//
//   POST /CreateOrderWithItems/
//     { orderId, items: [{id,name,price},...] }
//     Writes one Order + N OrderItems atomically in one request. Success path.
//
//   POST /CreateConcurrentItems/
//     { orderId, items: [{id,name,price},...] }
//     Each item is a separate call (used by the test to fire many parallel requests).
//     This is the per-item endpoint for the concurrent fan-out probe.

// ---------------------------------------------------------------------------
// POST /CreateOrderWithItem/  { orderId, itemId, name, price, fail=false }
// ---------------------------------------------------------------------------
export class CreateOrderWithItem extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const b = body || query || {};
		const orderId = b.orderId;
		const itemId = b.itemId;
		const name = b.name || 'item';
		const price = Number(b.price) || 1.0;
		const shouldFail = b.fail === true || b.fail === 'true';

		// Write parent row.
		await tables.Order.put({ id: orderId, total: price });

		if (shouldFail) {
			// Throw AFTER parent write, BEFORE child write.
			// Atomic => Order must roll back. Relationship index must be empty for orderId.
			throw new Error(`QA-162 forced throw after Order(${orderId}), before OrderItem`);
		}

		// Write child row — establishes the @relationship FK edge (orderId).
		await tables.OrderItem.put({ id: itemId, orderId, name, price });

		return { ok: true, orderId, itemId };
	}
}

// ---------------------------------------------------------------------------
// POST /CreateOrderWithItems/  { orderId, items: [{id,name,price},...] }
// ---------------------------------------------------------------------------
export class CreateOrderWithItems extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const b = body || query || {};
		const orderId = b.orderId;
		const items = Array.isArray(b.items) ? b.items : [];

		const total = items.reduce((s, it) => s + Number(it.price || 0), 0);
		await tables.Order.put({ id: orderId, total });

		for (const it of items) {
			await tables.OrderItem.put({ id: it.id, orderId, name: it.name || 'item', price: Number(it.price) || 1.0 });
		}

		return { ok: true, orderId, itemCount: items.length };
	}
}

// ---------------------------------------------------------------------------
// POST /AddOrderItem/  { orderId, itemId, name, price }
// Used by the concurrent fan-out probe: each call adds ONE child to an existing parent.
// ---------------------------------------------------------------------------
export class AddOrderItem extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const b = body || query || {};
		const orderId = b.orderId;
		const itemId = b.itemId;
		const name = b.name || 'item';
		const price = Number(b.price) || 1.0;

		await tables.OrderItem.put({ id: itemId, orderId, name, price });
		return { ok: true, orderId, itemId };
	}
}
