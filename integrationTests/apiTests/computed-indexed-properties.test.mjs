/**
 * Computed indexed properties integration tests.
 *
 * Ported from legacy `apiTests/tests/18_computedIndexedProperties.mjs`. Validates:
 * - `@computed(from: "...")` expressions produce correct indexed values
 * - `@computed` JS-callback attributes (`setComputedAttribute`) produce correct indexed values
 * - Non-indexed computed attributes round-trip correctly
 * - REST and operations API both surface computed values
 *
 * Self-contained: installs a `computed` component that defines a `Product` table
 * (schema `data`) with three computed fields, seeds one record, exercises read /
 * filter paths, then drops the record, table, and component.
 *
 * Skipped on Windows: depends on `restart_service http_workers` after component
 * install, which crashes Harper on the Windows single-worker model
 * (HarperFast/harper#549).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { cpus } from 'node:os';
import request from 'supertest';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { installAppComponent } from './utils/components.mjs';

const SCHEMA_GRAPHQL =
	'type Product @table @export { \n\t id: ID @primaryKey \n\t price: Float \n\t taxRate: Float \n\t' +
	' totalPrice: Float @computed(from: "price + (price * taxRate)") @indexed \n\t' +
	' notIndexedTotalPrice: Float @computed(from: "price + (price * taxRate)") \n\t' +
	' jsTotalPrice: Float @computed @indexed \n } \n\n';

const RESOURCES_JS =
	"tables.Product.setComputedAttribute('jsTotalPrice', (record) => { \n\t return record.price + (record.price * record.taxRate) \n }) \n\n";

const skipSuite = process.platform === 'win32';

/**
 * Poll until the JS-computed `jsTotalPrice` resolver is live on *every* http
 * worker before any real read or write lands.
 *
 * `jsTotalPrice` is `@computed @indexed` with no `from` expression — its
 * resolver is registered at runtime by resources.js (`setComputedAttribute`),
 * which sets per-worker in-memory state (Table.ts `userResolvers`), not at
 * schema-load time. The `/Product/` route (from the `@export`ed table) starts
 * serving as soon as the schema loads, which can be *before* resources.js
 * finishes running on a worker. Two failure modes flow from that, and Harper
 * runs many http workers (default: cpus-1), so a request can be load-balanced
 * (SO_REUSEPORT) to a worker that is still cold:
 *   - a PUT handled by a cold worker computes the `@indexed` value with a
 *     missing resolver, freezing `jsTotalPrice` as `undefined` in the index, so
 *     the `?jsTotalPrice=119` filter misses the record; and
 *   - a GET `?select(jsTotalPrice)` served by a cold worker recomputes the
 *     value with a missing resolver and returns null.
 *
 * The route probe in installAppComponent only proves the table is reachable on
 * one worker, not that the resolver is registered everywhere. This gate seeds a
 * throwaway record and reads the on-demand computed value in bursts (each burst
 * opens fresh connections — the client sends `Connection: close` — so requests
 * spread across workers) until several consecutive bursts see zero cold
 * responses, i.e. every worker has run resources.js. This is a client-side
 * readiness poll, in the spirit of restartHttpWorkers, so the suite stays
 * multi-worker (this is a functional test, not a single-thread special case).
 *
 * The probe record uses taxRate 0 so its computed values are PROBE_COMPUTED (a
 * value distinct from the 119 the real assertions filter on), so that even if
 * its cleanup delete is missed the leaked probe can never satisfy the
 * `?jsTotalPrice=119` / `?totalPrice=119` filter tests. readsPerBurst scales
 * with the host core count (workers default to cpus-1) so a straggler worker is
 * reliably hit even on high-core CI hosts.
 */
const PROBE_PRICE = 100;
const PROBE_COMPUTED = 100; // price + price * 0

async function waitForComputedResolver(
	client,
	{ readsPerBurst = Math.max(60, cpus().length * 8), requiredCleanBursts = 3, timeoutMs = 60000 } = {}
) {
	const probeId = '__computed_ready_probe__';
	const cleanup = () =>
		request(client.restURL)
			.delete(`/Product/${probeId}`)
			.set(client.headers)
			.catch(() => {});
	const deadline = Date.now() + timeoutMs;
	try {
		// Seed the probe record. A cold/restarting worker can transiently reset the
		// connection during warm-up, so retry (treating rejects + non-204 alike)
		// rather than failing the suite on a transient error.
		let seeded = false;
		while (!seeded && Date.now() < deadline) {
			try {
				const r = await request(client.restURL)
					.put(`/Product/${probeId}`)
					.set(client.headers)
					.send({ id: probeId, price: PROBE_PRICE, taxRate: 0 });
				seeded = r?.status === 204;
			} catch {
				// connection refused/reset while workers warm up — retry
			}
			if (!seeded) await sleep(150);
		}
		if (!seeded) throw new Error('failed to seed the computed-resolver probe record');

		let cleanBursts = 0;
		let lastCold = -1;
		while (Date.now() < deadline) {
			let cold = 0;
			for (let i = 0; i < readsPerBurst; i++) {
				// A request to a cold/restarting worker may reject (ECONNRESET/
				// ECONNREFUSED) or return a non-computed value; both count as cold so
				// the gate keeps polling instead of failing on a transient error.
				try {
					const r = await client.reqRest(`/Product/${probeId}?select(id,price,taxRate,jsTotalPrice)`);
					if (!(r?.status === 200 && r?.body?.jsTotalPrice === PROBE_COMPUTED)) cold++;
				} catch {
					cold++;
				}
			}
			lastCold = cold;
			if (cold === 0) {
				if (++cleanBursts >= requiredCleanBursts) return;
			} else {
				cleanBursts = 0;
			}
			await sleep(150);
		}
		throw new Error(
			`jsTotalPrice resolver not live on all workers within ${timeoutMs}ms (last burst cold=${lastCold}/${readsPerBurst})`
		);
	} finally {
		await cleanup();
	}
}

suite('Computed indexed properties', { skip: skipSuite }, (ctx) => {
	let client;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		await installAppComponent(client, {
			project: 'computed',
			files: { 'schema.graphql': SCHEMA_GRAPHQL, 'resources.js': RESOURCES_JS },
			probePath: '/Product/',
			restartTimeoutMs: 120000,
		});

		await waitForComputedResolver(client);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('PUT Product record via REST', async () => {
		await request(client.restURL)
			.put('/Product/1')
			.set(client.headers)
			.send({ id: '1', price: 100, taxRate: 0.19 })
			.expect(204);
	});

	test('search_by_value returns raw fields', async () => {
		const r = await client
			.req()
			.send({
				operation: 'search_by_value',
				schema: 'data',
				table: 'Product',
				search_attribute: 'id',
				search_value: '1',
			})
			.expect(200);

		assert.ok(Array.isArray(r.body), r.text);
		assert.equal(r.body[0].id, '1', r.text);
		assert.equal(r.body[0].price, 100, r.text);
		assert.equal(r.body[0].taxRate, 0.19, r.text);
	});

	test('search_by_value with get_attributes returns computed values', async () => {
		const r = await client
			.req()
			.send({
				operation: 'search_by_value',
				schema: 'data',
				table: 'Product',
				search_attribute: 'id',
				search_value: '1',
				get_attributes: ['id', 'price', 'taxRate', 'totalPrice', 'notIndexedTotalPrice', 'jsTotalPrice'],
			})
			.expect(200);

		assert.ok(Array.isArray(r.body), r.text);
		assert.equal(r.body[0].id, '1', r.text);
		assert.equal(r.body[0].price, 100, r.text);
		assert.equal(r.body[0].taxRate, 0.19, r.text);
		assert.equal(r.body[0].totalPrice, 119, r.text);
		assert.equal(r.body[0].notIndexedTotalPrice, 119, r.text);
		// jsTotalPrice is intentionally not asserted here: search_by_value is an
		// operations-API call served on the main thread, but the jsTotalPrice
		// resolver is registered by resources.js (setComputedAttribute) only on the
		// http workers. get_attributes recomputes computed fields on the main
		// thread, where the resolver is absent, so it resolves to null. The value
		// is verified via REST GET with ?select below (served by an http worker,
		// which has the resolver).
	});

	test('REST GET by id returns raw fields', async () => {
		const r = await client.reqRest('/Product/1').expect(200);
		assert.equal(r.body.id, '1', r.text);
		assert.equal(r.body.price, 100, r.text);
		assert.equal(r.body.taxRate, 0.19, r.text);
	});

	test('REST GET by id with select returns all computed values', async () => {
		const r = await client
			.reqRest('/Product/1?select(id,price,taxRate,totalPrice,notIndexedTotalPrice,jsTotalPrice)')
			.expect(200);
		assert.equal(r.body.id, '1', r.text);
		assert.equal(r.body.price, 100, r.text);
		assert.equal(r.body.taxRate, 0.19, r.text);
		assert.equal(r.body.totalPrice, 119, r.text);
		assert.equal(r.body.notIndexedTotalPrice, 119, r.text);
		assert.equal(r.body.jsTotalPrice, 119, r.text);
	});

	test('REST filter by JS-computed indexed attribute', async () => {
		const r = await client
			.reqRest('/Product/?jsTotalPrice=119&select(id,price,taxRate,totalPrice,notIndexedTotalPrice,jsTotalPrice)')
			.expect(200);
		assert.ok(Array.isArray(r.body), r.text);
		assert.equal(r.body[0].id, '1', r.text);
		assert.equal(r.body[0].price, 100, r.text);
		assert.equal(r.body[0].taxRate, 0.19, r.text);
		assert.equal(r.body[0].totalPrice, 119, r.text);
		assert.equal(r.body[0].notIndexedTotalPrice, 119, r.text);
		assert.equal(r.body[0].jsTotalPrice, 119, r.text);
	});

	test('REST filter by expression-computed indexed attribute', async () => {
		const r = await client
			.reqRest('/Product/?totalPrice=119&select(id,price,taxRate,totalPrice,notIndexedTotalPrice,jsTotalPrice)')
			.expect(200);
		assert.ok(Array.isArray(r.body), r.text);
		assert.equal(r.body[0].id, '1', r.text);
		assert.equal(r.body[0].price, 100, r.text);
		assert.equal(r.body[0].taxRate, 0.19, r.text);
		assert.equal(r.body[0].totalPrice, 119, r.text);
		assert.equal(r.body[0].notIndexedTotalPrice, 119, r.text);
		assert.equal(r.body[0].jsTotalPrice, 119, r.text);
	});

	test('delete Product record', async () => {
		await client
			.req()
			.send({ operation: 'delete', schema: 'data', table: 'Product', ids: ['1'] })
			.expect((r) => assert.ok(r.body.message.includes('1 of 1 record successfully deleted'), r.text))
			.expect((r) => assert.deepEqual(r.body.deleted_hashes, ['1'], r.text))
			.expect(200);
	});

	test('drop_table Product', async () => {
		await client
			.req()
			.send({ operation: 'drop_table', schema: 'data', table: 'Product' })
			.expect((r) => assert.ok(r.body.message.includes(`successfully deleted table 'data.Product'`), r.text))
			.expect(200);
	});

	test('drop_component computed', async () => {
		await client
			.req()
			.send({ operation: 'drop_component', project: 'computed' })
			.expect((r) => assert.ok(r.body.message.includes('Successfully dropped: computed'), r.text))
			.expect(200);
	});
});
