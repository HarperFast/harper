// QA-716 fixture. FulfillPage is the shape under test: it pages a status='pending' search, stages
// writes across Orders + Inventory + Reservation, and returns with the cursor simply dropped —
// never drained, never .return()'d — so the read handle outlives the request's own commit.
//
//   /Seed          { bucket, count }     — insert `count` pending Orders for bucket.
//   /FulfillPage   { bucket, pageSize }  — the repro.
//   GET /DumpOrders, /DumpInventory, /DumpReservation — base scans, index-independent.

function pad(n) {
	return String(n).padStart(6, '0');
}

export class Seed extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const bucket = b.bucket || 'B';
		const n = Number(b.count) || 10;
		const sku = `SKU-${bucket}`;
		for (let i = 0; i < n; i++) {
			await tables.Orders.put({ id: `${bucket}-${pad(i)}`, bucket, status: 'pending', sku, seq: i });
		}
		await tables.Inventory.put({ sku, fulfilledCount: 0 });
		return { ok: true, bucket, count: n, sku };
	}
}

export class FulfillPage extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const bucket = b.bucket || 'B';
		const pageSize = Number(b.pageSize) || 5;
		const sku = `SKU-${bucket}`;

		const iterator = tables.Orders.search({ conditions: [{ attribute: 'status', value: 'pending' }] })[
			Symbol.asyncIterator
		]();
		const picked = [];
		let scanned = 0;
		while (picked.length < pageSize && scanned < 20000) {
			const { value, done } = await iterator.next();
			if (done) break;
			scanned++;
			if (value.bucket === bucket) picked.push(value);
		}

		let fulfilledCount = (await tables.Inventory.get(sku))?.fulfilledCount ?? 0;
		for (const order of picked) {
			await tables.Orders.put({ id: order.id, bucket, status: 'fulfilled', sku, seq: order.seq });
			fulfilledCount++;
			await tables.Inventory.put({ sku, fulfilledCount });
			await tables.Reservation.put({ id: `${order.id}-hold`, sku, qty: 1 });
		}
		// NOTE: `iterator` is intentionally left open here — no more `.next()` calls, no `.return()`.
		return { ok: true, bucket, fulfilledIds: picked.map((o) => o.id), scanned };
	}
}

export class DumpOrders extends Resource {
	static loadAsInstance = false;
	async get() {
		const out = [];
		for await (const r of tables.Orders.search({}))
			out.push({ id: r.id, bucket: r.bucket, status: r.status, sku: r.sku });
		return out;
	}
}

export class DumpInventory extends Resource {
	static loadAsInstance = false;
	async get() {
		const out = [];
		for await (const r of tables.Inventory.search({})) out.push({ sku: r.sku, fulfilledCount: r.fulfilledCount });
		return out;
	}
}

export class DumpReservation extends Resource {
	static loadAsInstance = false;
	async get() {
		const out = [];
		for await (const r of tables.Reservation.search({})) out.push({ id: r.id, sku: r.sku, qty: r.qty });
		return out;
	}
}
