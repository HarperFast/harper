// QA-196 — Single-snapshot FK consistency oracle.
//
// GET /ConsistencyOracle/<orderId>
// OR GET /ConsistencyOracle/?orderId=<id>
//
// Reads both the FK index entries (search on orderId) AND the base Order record
// within a single resource call (single snapshot). Returns:
//   {
//     orderExists: bool,           // whether Order row with given id exists
//     indexCount: number,          // count of OrderItem rows with matching orderId via FK index
//     indexIds: string[],          // sorted ids found in FK index
//     itemsExist: [{id,exists}],   // for each index entry: does base record actually exist?
//     phantomIndexEntries: string[], // index entries where base record is missing (dangling)
//   }

export class ConsistencyOracle extends Resource {
	static loadAsInstance = false;

	async get(query) {
		// Support both /ConsistencyOracle/<id> (path id) and ?orderId=<id> (query param).
		let orderId = null;
		if (query && query.get) {
			orderId = query.get('orderId');
		} else if (query && query.orderId) {
			orderId = query.orderId;
		}
		// Fallback: use the path-based id if available.
		if (!orderId && query && query.id != null) {
			orderId = String(query.id);
		}

		if (!orderId) {
			this.getContext().response.status = 400;
			return { error: 'orderId param required (path or query)' };
		}

		// Read Order base record.
		const order = await tables.Order.get(orderId);

		// Read all OrderItems with this orderId via the FK index.
		// search({ orderId }) uses the @indexed orderId attribute.
		const indexItems = [];
		for await (const item of tables.OrderItem.search({ orderId })) {
			indexItems.push(String(item.id));
		}

		const indexIds = indexItems.sort();

		// For each index entry, verify the base record actually exists.
		const itemExistChecks = await Promise.all(
			indexIds.map(async (id) => {
				const rec = await tables.OrderItem.get(id);
				return { id, exists: rec != null };
			})
		);

		const phantomIndexEntries = itemExistChecks.filter((c) => !c.exists).map((c) => c.id);

		return {
			orderExists: order != null,
			indexCount: indexIds.length,
			indexIds,
			itemsExist: itemExistChecks,
			phantomIndexEntries,
		};
	}
}
