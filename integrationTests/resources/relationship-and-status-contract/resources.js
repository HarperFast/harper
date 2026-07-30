/* oxlint-disable no-undef -- intentionally references the (absent) ClientError sandbox global to characterize D-070 */
// Merged jsResource fixture for QA-196, QA-162, QA-195 — shared Harper instance
// (instance-affinity consolidation; see relationship-and-status-contract.test.ts).

// =============================================================================
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
// =============================================================================
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

// =============================================================================
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
//   POST /AddOrderItem/
//     { orderId, itemId, name, price }
//     Adds ONE child to an existing parent. Used by the concurrent fan-out probe.
// =============================================================================
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

// =============================================================================
// QA-195 — Custom-Resource AUTHOR status-code + body contract.
//
// Probes the full return/throw matrix that a custom Resource author can produce:
//
// RETURN shapes (all via ReturnMatrix GET ?case=<name>):
//   plain-object | array | string | number | bool-true | bool-false | null | undefined | promise-object
//
// THROW shapes (all via ThrowMatrix GET ?case=<name>):
//   plain-error       -> throw new Error('msg')
//   statuscode-400    -> Error with .statusCode=400
//   statuscode-404    -> Error with .statusCode=404
//   client-error-def  -> new ClientError('msg')   [default 400]
//   client-error-422  -> new ClientError('msg', 422)
//   bare-string       -> throw 'oops'
//   bare-number       -> throw 404
//   obj-statusCode    -> throw {statusCode: 404, message: 'nope'}
//   obj-status        -> throw {status: 400, body: 'bad'}  (status field, not statusCode)
//   throw-response    -> throw new Response('body', {status: 422})
//   reject-promise    -> get() returns Promise.reject(new Error('rejected'))
//   null-throw        -> throw null
//
// POST/PUT throw shapes (ThrowPost, ThrowPut): same cases via body {case:...}
//
// Additional probes:
//   /StatusViaContext/?code=N  -> set status via this.getContext().response.status
//   /StatusViaResponse/?code=N -> return new Response(body, {status:N})
//   /StatusViaObjStatus/?code=N -> return {status:N, data:{ok:true}}  (obj-status pattern)
//   /Liveness/                 -> always returns {alive:true, method:'get'}
// =============================================================================

export class ReturnMatrix extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const c = query?.get && query.get('case');
		switch (c) {
			case 'plain-object':
				return { value: 1, label: 'plain-object' };
			case 'array':
				return [1, 2, 3];
			case 'string':
				return 'hello';
			case 'number':
				return 42;
			case 'bool-true':
				return true;
			case 'bool-false':
				return false;
			case 'null':
				return null;
			case 'undefined':
				return undefined;
			case 'promise-object':
				return Promise.resolve({ value: 'from-promise' });
			default:
				return { error: 'unknown case', case: c };
		}
	}
}

export class ThrowMatrix extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const c = query?.get && query.get('case');
		switch (c) {
			case 'plain-error':
				throw new Error('QA195 plain error message');

			case 'statuscode-400': {
				const e = new Error('QA195 error.statusCode=400 message');
				e.statusCode = 400;
				throw e;
			}
			case 'statuscode-404': {
				const e = new Error('QA195 error.statusCode=404 message');
				e.statusCode = 404;
				throw e;
			}
			case 'client-error-def':
				// ClientError is injected into the resource sandbox via the framework
				if (typeof ClientError !== 'undefined') {
					throw new ClientError('QA195 ClientError default (400)');
				}
				// fallback: plain error with statusCode
				{
					const e = new Error('QA195 ClientError-unavailable fallback');
					e.statusCode = 400;
					throw e;
				}

			case 'client-error-422':
				if (typeof ClientError !== 'undefined') {
					throw new ClientError('QA195 ClientError 422', 422);
				}
				{
					const e = new Error('QA195 ClientError-422 fallback');
					e.statusCode = 422;
					throw e;
				}

			case 'bare-string':
				throw 'QA195 bare thrown string';

			case 'bare-number':
				throw 404;

			case 'obj-statusCode':
				// Plain object with .statusCode — not an Error instance
				throw { statusCode: 404, message: 'QA195 obj-statusCode nope' };

			case 'obj-status':
				// Plain object with .status (NOT .statusCode) — common mistake
				throw { status: 400, body: 'QA195 obj-status bad', message: 'QA195 obj-status message' };

			case 'throw-response':
				// Some frameworks short-circuit throw Response; does Harper?
				throw new Response(JSON.stringify({ shortCircuit: true, qa: 'QA195' }), {
					status: 422,
					headers: { 'Content-Type': 'application/json', 'X-QA195-Thrown': 'response' },
				});

			case 'reject-promise':
				return Promise.reject(new Error('QA195 rejected promise error'));

			case 'null-throw':
				throw null;

			default:
				return { error: 'unknown throw case', case: c };
		}
	}
}

export class ThrowPost extends Resource {
	static loadAsInstance = false;
	async post(query, data) {
		const c = data?.case;
		switch (c) {
			case 'plain-error':
				throw new Error('QA195-POST plain error');
			case 'statuscode-400': {
				const e = new Error('QA195-POST statusCode=400');
				e.statusCode = 400;
				throw e;
			}
			case 'client-error-def':
				if (typeof ClientError !== 'undefined') throw new ClientError('QA195-POST ClientError');
				{
					const e = new Error('QA195-POST ClientError fallback');
					e.statusCode = 400;
					throw e;
				}
			case 'obj-statusCode':
				throw { statusCode: 409, message: 'QA195-POST obj-statusCode conflict' };
			case 'obj-status':
				throw { status: 400, body: 'QA195-POST obj-status bad' };
			default:
				return { ok: true, received: c };
		}
	}
}

export class ThrowPut extends Resource {
	static loadAsInstance = false;
	async put(query, data) {
		const c = data?.case;
		switch (c) {
			case 'plain-error':
				throw new Error('QA195-PUT plain error');
			case 'statuscode-400': {
				const e = new Error('QA195-PUT statusCode=400');
				e.statusCode = 400;
				throw e;
			}
			case 'client-error-def':
				if (typeof ClientError !== 'undefined') throw new ClientError('QA195-PUT ClientError');
				{
					const e = new Error('QA195-PUT ClientError fallback');
					e.statusCode = 400;
					throw e;
				}
			case 'obj-statusCode':
				throw { statusCode: 422, message: 'QA195-PUT obj-statusCode unprocessable' };
			case 'obj-status':
				throw { status: 400, body: 'QA195-PUT obj-status bad' };
			default:
				return { ok: true, received: c };
		}
	}
}

export class StatusViaContext extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const want = Number((query?.get && query.get('code')) || 201);
		const ctx = this.getContext();
		if (ctx?.response) {
			ctx.response.status = want;
			ctx.response.headers.set('X-QA195', 'context');
		}
		return { setVia: 'context', code: want };
	}
}

export class StatusViaResponse extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const want = Number((query?.get && query.get('code')) || 201);
		return new Response(JSON.stringify({ setVia: 'Response', code: want }), {
			status: want,
			headers: { 'Content-Type': 'application/json', 'X-QA195': 'response' },
		});
	}
}

export class StatusViaObjStatus extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const want = Number((query?.get && query.get('code')) || 202);
		// REST.ts lines 164-191: if responseData.headers exists it enters the Response branch.
		// Does returning {status, data} without headers also work?
		return { status: want, data: { setVia: 'obj-status', code: want } };
	}
}

// THROW-RESPONSE-AFTER-WRITE — POST writes Kv(id) then throws a Response.
// A thrown Response surfaces its status/body, but (like any throw) ABORTS the
// transaction, so the write must NOT persist. Documents the "throw = rollback"
// contract for thrown Responses.
export class ThrowResponseAfterWrite extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const id = (body && body.id) || 'twr';
		await tables.Kv.put({ id, v: 'should-not-persist' });
		throw new Response(JSON.stringify({ thrown: true, id }), {
			status: 201,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

export class Liveness extends Resource {
	static loadAsInstance = false;
	async get() {
		return { alive: true, method: 'get' };
	}
}
