import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, envUrlRest, generic, headers } from '../config/envConfig.js';
import { setTimeout } from 'node:timers/promises';

describe('18. Computed indexed properties', () => {
	//Computed indexed properties Folder

	it('Add component', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'add_component', project: 'computed' })
			.expect((r) => assert.ok(r.body.message.includes('Successfully added project: computed')))
			.expect(200);
	});

	it('Set Component File schema.graphql', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'set_component_file',
				project: 'computed',
				file: 'schema.graphql',
				payload:
					'type Product @table @export { \n\t id: ID @primaryKey \n\t price: Float \n\t taxRate: Float \n\t totalPrice: Float @computed(from: "price + (price * taxRate)") @indexed \n\t notIndexedTotalPrice: Float @computed(from: "price + (price * taxRate)") \n\t jsTotalPrice: Float @computed @indexed \n } \n\n',
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: schema.graphql')))
			.expect(200);
	});

	it('Set Component File resources.js', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'set_component_file',
				project: 'computed',
				file: 'resources.js',
				payload:
					"tables.Product.setComputedAttribute('jsTotalPrice', (record) => { \n\t return record.price + (record.price * record.taxRate) \n }) \n\n",
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: resources.js')))
			.expect(200);
	});

	it('Restart service and wait', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'restart' })
			.expect((r) => {
				assert.ok(r.body.message.includes('Restarting'));
				console.log('restart and wait for ' + generic.restartTimeout + 'milliseconds');
			});
		await setTimeout(generic.restartTimeout);
	});

	it('Insert data', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'insert', table: 'Product', records: [{ id: '1', price: 100, taxRate: 0.19 }] })
			.expect((r) => assert.ok(r.body.message.includes('inserted 1 of 1 records')))
			.expect(200);
	});

	it('Search for attribute', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'search_by_value',
				schema: 'data',
				table: 'Product',
				search_attribute: 'id',
				search_value: '1',
			})
			.expect((r) => assert.ok(r.body[0].id == '1'))
			.expect((r) => assert.ok(r.body[0].price == 100))
			.expect((r) => assert.ok(r.body[0].taxRate == 0.19))
			.expect(200);
	});

	it('Search and get attributes', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'search_by_value',
				schema: 'data',
				table: 'Product',
				search_attribute: 'id',
				search_value: '1',
				get_attributes: ['id', 'price', 'taxRate', 'totalPrice', 'notIndexedTotalPrice', 'jsTotalPrice'],
			})
			.expect((r) => assert.ok(r.body[0].id == '1'))
			.expect((r) => assert.ok(r.body[0].price == 100))
			.expect((r) => assert.ok(r.body[0].taxRate == 0.19))
			.expect((r) => assert.ok(r.body[0].totalPrice == 119))
			.expect((r) => assert.ok(r.body[0].notIndexedTotalPrice == 119))
			.expect((r) => assert.ok(r.body[0].jsTotalPrice == 119))
			.expect(200);
	});

	it('Search REST id', async () => {
		const response = await request(envUrlRest)
			.get('/Product/1')
			.set(headers)
			.expect((r) => assert.ok(r.body.message.includes('inserted 1 of 1 records')))
			.expect((r) => assert.ok(r.body.price == 100))
			.expect((r) => assert.ok(r.body.taxRate == 0.19))
			.expect(200);
	});

	it('Search REST id select', async () => {
		const response = await request(envUrlRest)
			.get('/Product/1?select(id,price,taxRate,totalPrice,notIndexedTotalPrice,jsTotalPrice)')
			.set(headers)
			.expect((r) => assert.ok(r.body.message.includes('inserted 1 of 1 records')))
			.expect((r) => assert.ok(r.body.price == 100))
			.expect((r) => assert.ok(r.body.taxRate == 0.19))
			.expect((r) => assert.ok(r.body.totalPrice == 119))
			.expect((r) => assert.ok(r.body.notIndexedTotalPrice == 119))
			.expect((r) => assert.ok(r.body.jsTotalPrice == 119))
			.expect(200);
	});

	it('Search REST attribute select', async () => {
		const response = await request(envUrlRest)
			.get('/Product/?jsTotalPrice=119&select(id,price,taxRate,totalPrice,notIndexedTotalPrice,jsTotalPrice)')
			.set(headers)
			.expect((r) => assert.ok(r.body[0].id == '1'))
			.expect((r) => assert.ok(r.body[0].price == 100))
			.expect((r) => assert.ok(r.body[0].taxRate == 0.19))
			.expect((r) => assert.ok(r.body[0].totalPrice == 119))
			.expect((r) => assert.ok(r.body[0].notIndexedTotalPrice == 119))
			.expect((r) => assert.ok(r.body[0].jsTotalPrice == 119))
			.expect(200);
	});

	it('Search REST attribute 2 select', async () => {
		const response = await request(envUrlRest)
			.get('/Product/?totalPrice=119&select(id,price,taxRate,totalPrice,notIndexedTotalPrice,jsTotalPrice)')
			.set(headers)
			.expect((r) => assert.ok(r.body[0].id == '1'))
			.expect((r) => assert.ok(r.body[0].price == 100))
			.expect((r) => assert.ok(r.body[0].taxRate == 0.19))
			.expect((r) => assert.ok(r.body[0].totalPrice == 119))
			.expect((r) => assert.ok(r.body[0].notIndexedTotalPrice == 119))
			.expect((r) => assert.ok(r.body[0].jsTotalPrice == 119))
			.expect(200);
	});

	it('Delete data', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'delete', table: 'Product', ids: ['1'] })
			.expect((r) => assert.ok(r.body.message.includes('1 of 1 record successfully deleted')))
			.expect((r) => assert.deepEqual(r.body.deleted_hashes, ['1']))
			.expect(200);
	});

	it('Delete table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_table', table: 'Product' })
			.expect((r) => assert.ok(r.body.message.includes(`successfully deleted table 'data.Product'`)))
			.expect(200);
	});

	it('Delete schema', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_schema', schema: 'data' })
			.expect((r) => assert.ok(r.body.message.includes(`successfully deleted 'data'`)))
			.expect(200);
	});

	it('Drop component', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_component', project: 'computed' })
			.expect((r) => assert.ok(r.body.message.includes('Successfully dropped: computed')))
			.expect(200);
	});
});
