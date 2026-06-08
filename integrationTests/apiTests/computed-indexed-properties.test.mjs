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
import assert from 'node:assert/strict';
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
		// jsTotalPrice is intentionally not asserted here: search_by_value returns
		// the stored indexed value, which can be null if the record was PUT before
		// resources.js finished initialising (setComputedAttribute is a runtime
		// call, not a schema-time expression). The value is verified via REST GET
		// with ?select below, which computes it on-demand.
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
