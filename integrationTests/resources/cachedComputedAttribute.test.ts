/**
 * harper#2359 — a cache table with a scalar `@computed` attribute. A source-filled record was durably
 * encoded through the response projection that surfaces computed values, so the computed value became
 * a stored field; materializing it then assigned that value through the computed accessor, which has
 * no setter, and every read, query, invalidate and delete of the record threw. Affects 5.2.0-5.2.6.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'cached-computed-attribute');

suite('cache table with a computed attribute', (ctx: ContextWithHarper) => {
	let request: (path: string, init?: RequestInit) => Promise<Response>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
		const { admin, httpURL } = ctx.harper;
		const authorization = 'Basic ' + Buffer.from(`${admin.username}:${admin.password}`).toString('base64');
		request = (path, init = {}) =>
			fetch(`${httpURL}${path}`, { ...init, headers: { authorization, ...(init.headers ?? {}) } });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// The fixture reports whether the record is present in the table's own store, which is only true
	// once the cache-fill write has committed.
	async function waitForStoredRecord(id: string) {
		for (let attempt = 0; attempt < 100; attempt++) {
			const response = await request(`/StoredState/${id}`);
			if (response.status === 200 && ((await response.json()) as any).stored === true) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`the cache-fill write for ${id} never reached the store`);
	}

	test('a source-filled record stays readable after the cache fill', async () => {
		const fill = await request('/CachedProduct/plain-1');
		strictEqual(fill.status, 200);
		strictEqual(((await fill.json()) as any).salePrice, 60);

		// The cache write commits behind the fill response, so wait for the record to be readable from
		// storage rather than assuming the next read is: an immediate re-read that raced the commit
		// would be another source fetch, and would pass without ever exercising the failing path.
		await waitForStoredRecord('plain-1');

		const cached = await request('/CachedProduct/plain-1');
		const body = await cached.text();
		strictEqual(cached.status, 200, `cached read failed: ${body}`);
		strictEqual(JSON.parse(body).salePrice, 60);
	});

	test('the durable record carries no computed value', async () => {
		await request('/CachedProduct/durable-1');
		await waitForStoredRecord('durable-1');

		const stored = await request('/StoredKeys/durable-1');
		strictEqual(stored.status, 200);
		const keys = ((await stored.json()) as any).keys as string[];
		ok(Array.isArray(keys), `expected stored keys, got ${JSON.stringify(keys)}`);
		ok(keys.includes('price'), `expected the stored fields, got ${JSON.stringify(keys)}`);
		ok(!keys.includes('salePrice'), `the computed value must not be stored: ${JSON.stringify(keys)}`);
	});

	test('the cached record is reachable by query, invalidation and re-read', async () => {
		strictEqual((await request('/CachedProduct/plain-2')).status, 200);
		// The cache write commits behind the fill response; the query below reads the store.
		await waitForStoredRecord('plain-2');

		const query = await request('/CachedProduct/?price=100');
		strictEqual(query.status, 200);
		const rows = (await query.json()) as any[];
		const row = rows.find((candidate) => candidate.id === 'plain-2');
		ok(row, `queried record missing: ${JSON.stringify(rows).slice(0, 400)}`);
		// A materialization failure inside a query surfaces as an error object in an HTTP 200 result
		// set rather than as a failed request, so the row itself has to be checked.
		ok(!('error' in row), `query returned an error row: ${JSON.stringify(row)}`);
		strictEqual(row.salePrice, 60);

		const invalidated = await request('/CachedProduct/plain-2', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'invalidate' }),
		});
		ok(invalidated.status < 500, `invalidation failed: ${invalidated.status} ${await invalidated.text()}`);
		strictEqual((await request('/CachedProduct/plain-2')).status, 200);
	});

	test('a record stored by an affected release is readable again, with the resolver authoritative', async () => {
		const planted = await request('/PoisonedRecord/legacy-1', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ price: 100, discount: 40, salePrice: 999 }),
		});
		ok(planted.status < 300, `planting failed: ${planted.status} ${await planted.text()}`);

		// Contamination cannot be observed through a read (materialization is what discards the key);
		// the planted-bytes probe below is what proves the record really is contaminated.
		const read = await request('/CachedProduct/legacy-1');
		const body = await read.text();
		strictEqual(read.status, 200, `a record stored by an affected release must still read: ${body}`);
		strictEqual(JSON.parse(body).salePrice, 60, 'the resolver, not the stored value, must be authoritative');

		const query = await request('/CachedProduct/?price=100');
		strictEqual(query.status, 200);
		const row = ((await query.json()) as any[]).find((candidate) => candidate.id === 'legacy-1');
		ok(row, 'the record must be queryable');
		ok(!('error' in row), `query returned an error row: ${JSON.stringify(row)}`);
		strictEqual(row.salePrice, 60);

		// Non-vacuity for the durable-record probe: it must be able to see a stored computed value.
		const stored = await request('/StoredKeys/legacy-1');
		strictEqual(stored.status, 200);
		ok(
			((await stored.json()) as any).keys?.includes('salePrice'),
			'the planted record must actually carry the stored computed value'
		);
	});

	test('re-encoding an existing record keeps every stored field', async () => {
		const put = await request('/PlainProduct/plain-update', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ price: 100, discount: 40, label: 'keep me' }),
		});
		ok(put.status < 300, `put failed: ${put.status} ${await put.text()}`);

		// A partial update reads, merges and writes the record back, so the projection sees a record
		// instance rather than a request body — the case where projecting by own keys would encode an
		// empty record.
		const patch = await request('/PlainProduct/plain-update', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ discount: 25 }),
		});
		ok(patch.status < 300, `patch failed: ${patch.status} ${await patch.text()}`);

		const read = await request('/PlainProduct/plain-update');
		strictEqual(read.status, 200);
		const record = (await read.json()) as any;
		strictEqual(record.price, 100, 'an untouched stored field must survive the re-encode');
		strictEqual(record.label, 'keep me', 'an untouched stored field must survive the re-encode');
		strictEqual(record.discount, 25);
		strictEqual(record.salePrice, 75);
	});

	test('invalidating a row with an indexed computed attribute leaves it readable', async () => {
		const put = await request('/PlainProduct/invalidated-1', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ price: 100, discount: 40, label: 'invalidate me' }),
		});
		ok(put.status < 300, `put failed: ${put.status} ${await put.text()}`);

		// Invalidation preserves every indexed attribute's value in the partial record so the row stays
		// searchable, which for an indexed computed attribute means storing the computed value — the
		// same collision as a cache fill, reached with no cache source and no replication.
		const invalidated = await request('/PlainProductResource/invalidated-1', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		ok(invalidated.status < 300, `invalidation failed: ${invalidated.status} ${await invalidated.text()}`);

		// Invalidation reduces the row to a stub, so what is under test is that reading it works at all
		// rather than what it still contains.
		const read = await request('/PlainProduct/invalidated-1');
		const body = await read.text();
		strictEqual(read.status, 200, `an invalidated row must still read: ${body}`);
		ok(!body.includes('attribute.set'), `the invalidated row failed to materialize: ${body}`);
	});

	test('a cache fill with a dangling @enumerable relationship stays readable', async () => {
		// The relationship half of the defect, present since 5.1.0: the cache-fill record is
		// struct-prototyped, so its durable encode used to run the response projection and bake the
		// resolved relationship value in; a dangling foreign key resolves to undefined, and the stored
		// undefined then crashed the relationship setter on every later materialization.
		const fill = await request('/CachedItem/item-dangling-1');
		strictEqual(fill.status, 200);
		await waitForStoredRecord('item-dangling-1');

		const cached = await request('/CachedItem/item-dangling-1');
		const body = await cached.text();
		strictEqual(cached.status, 200, `cached read failed: ${body}`);
		strictEqual(JSON.parse(body).catId, 'no-such-cat');

		const query = await request('/CachedItem/?catId=no-such-cat');
		strictEqual(query.status, 200);
		const row = ((await query.json()) as any[]).find((candidate) => candidate.id === 'item-dangling-1');
		ok(row, 'the record must be queryable');
		ok(!('error' in row), `query returned an error row: ${JSON.stringify(row)}`);
	});

	test('a source returning the related object gets its foreign key derived', async () => {
		const fill = await request('/CachedItem/item-relobj-1');
		strictEqual(fill.status, 200);
		await waitForStoredRecord('item-relobj-1');

		const cached = await request('/CachedItem/item-relobj-1');
		const body = await cached.text();
		strictEqual(cached.status, 200, `cached read failed: ${body}`);
		strictEqual(JSON.parse(body).catId, 'a', 'the foreign key must be derived from the related object');
	});

	test('a malformed relationship value from a source never wipes the foreign key', async () => {
		for (const id of ['item-relscalar-1', 'item-relnopk-1']) {
			strictEqual((await request(`/CachedItem/${id}`)).status, 200);
			await waitForStoredRecord(id);

			const cached = await request(`/CachedItem/${id}`);
			const body = await cached.text();
			strictEqual(cached.status, 200, `${id} cached read failed: ${body}`);
			strictEqual(JSON.parse(body).catId, 'a', `${id} must keep the source's foreign key`);
		}
	});

	test('a record stored with a value under a relationship name still materializes, keeping its foreign key', async () => {
		// Shapes an affected release could have persisted under an @enumerable relationship name.
		// null is what the projection wrote for a dangling foreign key; the scalar shape used to
		// destroy the foreign key by deriving it from the stale stored value.
		for (const [id, stored] of [
			['rel-null', null],
			['rel-object', { slug: 'a', name: 'A' }],
			['rel-scalar', 'a'],
		] as const) {
			const planted = await request(`/PoisonedRelationship/${id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ label: 'L', catId: 'a', cat: stored }),
			});
			ok(planted.status < 300, `planting ${id} failed: ${planted.status} ${await planted.text()}`);

			const read = await request(`/Item/${id}`);
			const body = await read.text();
			strictEqual(read.status, 200, `${id} must still read: ${body}`);
			strictEqual(JSON.parse(body).catId, 'a', `${id} must keep its foreign key`);

			// The store's own getRange promotion — the path full-copy replication iterates — drives the
			// writable relationship setter unless the colliding key is skipped: a stored null crashes it
			// and a stored scalar rewrites the foreign key.
			const ranged = await request(`/RangeScanItem/${id}`);
			const rangedText = await ranged.text();
			strictEqual(ranged.status, 200, `${id} range materialization failed: ${rangedText}`);
			strictEqual(JSON.parse(rangedText)?.catId, 'a', `${id} must keep its foreign key on the range path`);
		}
	});

	test('a source value under a computed attribute never outranks the resolver', async () => {
		const fill = await request('/CachedProduct/colliding-1');
		strictEqual(fill.status, 200);
		strictEqual(
			((await fill.json()) as any).salePrice,
			60,
			'the cache-fill response must report the resolver, not the value the source supplied'
		);

		await waitForStoredRecord('colliding-1');
		const cached = await request('/CachedProduct/colliding-1');
		strictEqual(cached.status, 200);
		strictEqual(((await cached.json()) as any).salePrice, 60, 'the read must report the resolver');

		// The durable bytes themselves, not just the read: with the read-side discard in place the
		// resolver wins either way, so only the stored keys prove the write side dropped the value.
		const stored = await request('/StoredKeys/colliding-1');
		strictEqual(stored.status, 200);
		const keys = ((await stored.json()) as any).keys as string[];
		ok(keys?.includes('price'), `expected stored fields: ${JSON.stringify(keys)}`);
		ok(!keys.includes('salePrice'), `the source value must not be stored: ${JSON.stringify(keys)}`);
	});
});
