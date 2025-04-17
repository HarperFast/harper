import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reqRest } from '../utils/request.js';

describe('20. REST tests', () => {
	//REST tests Folder

	it('[rest] Named query Get Related', async () => {
		await reqRest('/Related/?select(id,name)')
			.expect((r) => assert.equal(r.body.length, 5, r.text))
			.expect((r) => {
				r.body.forEach((row, i) => {
					assert.equal(row.id, (i + 1).toString(), r.text);
				});
			})
			.expect(200);
	});

	it('[rest] Named query Get SubObject', async () => {
		await reqRest('/SubObject/?select(id,relatedId)')
			.expect((r) => assert.equal(r.body.length, 6, r.text))
			.expect((r) => {
				r.body.forEach((row, i) => {
					assert.equal(row.id, i.toString(), r.text);
				});
			})
			.expect(200);
	});

	it('[rest] Query by primary key field', async () => {
		await reqRest('/Related/?id==1&select(id,name)')
			.expect((r) => assert.equal(r.body[0].id, '1', r.text))
			.expect(200);
	});

	it('[rest] Query by variable non null', async () => {
		await reqRest('/Related/?id==2&select(id,name)')
			.expect((r) => assert.equal(r.body[0].id, '2', r.text))
			.expect(200);
	});

	it('[rest] Query by var nullable', async () => {
		await reqRest('/SubObject/?any==any-2&select(id,any)')
			.expect((r) => assert.equal(r.body[0].id, '2', r.text))
			.expect(200);
	});

	it('[rest] Query by var with null var', async () => {
		await reqRest('/SubObject/?any==null&select(id,any)')
			.expect((r) => assert.equal(r.body[0].id, '0', r.text))
			.expect((r) => assert.equal(r.body[0].any, null, r.text))
			.expect(200);
	});

	it('[rest] Query by nested attribute', async () => {
		await reqRest('/SubObject/?related.name==name-2&select(id,any)')
			.expect((r) => assert.equal(r.body[0].id, '2', r.text))
			.expect(200);
	});

	it('[rest] Query by multiple nested attributes', async () => {
		await reqRest('/SubObject/?any==any-2&related.name==name-2&select(id,any)')
			.expect((r) => assert.equal(r.body[0].id, '2', r.text))
			.expect(200);
	});

	it('[rest] Query by nested attribute primary key', async () => {
		await reqRest('/SubObject/?related.id==2&select(id,any)')
			.expect((r) => assert.equal(r.body[0].id, '2', r.text))
			.expect(200);
	});

	it('[rest] Query by doubly nested attribute', async () => {
		await reqRest('/SubObject/?related.subObject.any==any-2&select(id,any)')
			.expect((r) => assert.equal(r.body[0].id, '2', r.text))
			.expect(200);
	});

	it('[rest] Query with nested fragments', async () => {
		await reqRest('/Related/?id==3')
			.expect((r) => assert.equal(r.body[0].id, '3', r.text))
			.expect(200);
	});
});
