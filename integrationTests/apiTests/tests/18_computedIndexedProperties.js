import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { req, reqRest } from '../utils/request.js';

describe('18. Computed indexed properties', () => {
	//Computed indexed properties Folder

	it('Insert data',  () => {
		return req()
			.send({ operation: 'insert', table: 'Product', records: [{ id: '1', price: 100, taxRate: 0.19 }] })
			.expect((r) => assert.ok(r.body.message.includes('inserted 1 of 1 records'), r.text))
			.expect(200);
	});

	it('Search for attribute',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: 'data',
				table: 'Product',
				search_attribute: 'id',
				search_value: '1',
			})
			.expect((r) => {
				assert.equal(r.body[0].id, '1', r.text);
				assert.equal(r.body[0].price, 100, r.text);
				assert.equal(r.body[0].taxRate, 0.19, r.text);
			})
			.expect(200);
	});

	it('Search and get attributes',  () => {
		return req()
			.send({
				operation: 'search_by_value',
				schema: 'data',
				table: 'Product',
				search_attribute: 'id',
				search_value: '1',
				get_attributes: ['id', 'price', 'taxRate', 'totalPrice', 'notIndexedTotalPrice', 'jsTotalPrice'],
			})
			.expect((r) => {
				assert.equal(r.body[0].id, '1', r.text);
				assert.equal(r.body[0].price, 100, r.text);
				assert.equal(r.body[0].taxRate, 0.19, r.text);
				assert.equal(r.body[0].totalPrice, 119, r.text);
				assert.equal(r.body[0].notIndexedTotalPrice, 119, r.text);
				assert.equal(r.body[0].jsTotalPrice, 119, r.text);
			})
			.expect(200);
	});

	it('Search REST id',  () => {
		return reqRest('/Product/1')
			.expect((r) => {
				assert.equal(r.body.id, '1', r.text);
				assert.equal(r.body.price, 100, r.text);
				assert.equal(r.body.taxRate, 0.19, r.text);
			})
			.expect(200);
	});

	it('Search REST id select',  () => {
		return reqRest('/Product/1?select(id,price,taxRate,totalPrice,notIndexedTotalPrice,jsTotalPrice)')
			.expect((r) => {
				assert.equal(r.body.id, '1', r.text);
				assert.equal(r.body.price, 100, r.text);
				assert.equal(r.body.taxRate, 0.19, r.text);
				assert.equal(r.body.totalPrice, 119, r.text);
				assert.equal(r.body.notIndexedTotalPrice, 119, r.text);
				assert.equal(r.body.jsTotalPrice, 119, r.text);
			})
			.expect(200);
	});

	it('Search REST attribute select',  () => {
		return reqRest('/Product/?jsTotalPrice=119&select(id,price,taxRate,totalPrice,notIndexedTotalPrice,jsTotalPrice)')
			.expect((r) => {
				assert.equal(r.body[0].id, '1', r.text);
				assert.equal(r.body[0].price, 100, r.text);
				assert.equal(r.body[0].taxRate, 0.19, r.text);
				assert.equal(r.body[0].totalPrice, 119, r.text);
				assert.equal(r.body[0].notIndexedTotalPrice, 119, r.text);
				assert.equal(r.body[0].jsTotalPrice, 119, r.text);
			})
			.expect(200);
	});

	it('Search REST attribute 2 select',  () => {
		return reqRest('/Product/?totalPrice=119&select(id,price,taxRate,totalPrice,notIndexedTotalPrice,jsTotalPrice)')
			.expect((r) => {
				assert.equal(r.body[0].id, '1', r.text);
				assert.equal(r.body[0].price, 100, r.text);
				assert.equal(r.body[0].taxRate, 0.19, r.text);
				assert.equal(r.body[0].totalPrice, 119, r.text);
				assert.equal(r.body[0].notIndexedTotalPrice, 119, r.text);
				assert.equal(r.body[0].jsTotalPrice, 119, r.text);
			})
			.expect(200);
	});

	it('Delete data',  () => {
		return req()
			.send({ operation: 'delete', table: 'Product', ids: ['1'] })
			.expect((r) => assert.ok(r.body.message.includes('1 of 1 record successfully deleted'), r.text))
			.expect((r) => assert.deepEqual(r.body.deleted_hashes, ['1'], r.text))
			.expect(200);
	});

	it('Delete table',  () => {
		return req()
			.send({ operation: 'drop_table', table: 'Product' })
			.expect((r) => assert.ok(r.body.message.includes(`successfully deleted table 'data.Product'`), r.text))
			.expect(200);
	});

	it('Drop component',  () => {
		return req()
			.send({ operation: 'drop_component', project: 'computed' })
			.expect((r) => assert.ok(r.body.message.includes('Successfully dropped: computed'), r.text))
			.expect(200);
	});
});
