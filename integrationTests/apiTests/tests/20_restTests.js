import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrlRest, headers } from '../config/envConfig.js';

describe('20. REST tests', () => {
	//REST tests Folder

	it('[rest] Named query Get Related', async () => {
		const response = await request(envUrlRest)
			.get('/Related/?select(id,name)')
			.set(headers)
			.expect((r) => assert.ok(r.body.length == 5))
			.expect((r) => {
				r.body.forEach((row, i) => {
					assert.ok(row.id == (i + 1).toString());
				});
			})
			.expect(200);
	});

	it('[rest] Named query Get SubObject', async () => {
		const response = await request(envUrlRest)
			.get('/SubObject/?select(id,relatedId)')
			.set(headers)
			.expect((r) => assert.ok(r.body.length == 6))
			.expect((r) => {
				r.body.forEach((row, i) => {
					assert.ok(row.id == i.toString());
				});
			})
			.expect(200);
	});

	it('[rest] Query by primary key field', async () => {
		const response = await request(envUrlRest)
			.get('/Related/?id==1&select(id,name)')
			.set(headers)
			.expect((r) => assert.ok(r.body[0].id == '1'))
			.expect(200);
	});

	it('[rest] Query by variable non null', async () => {
		const response = await request(envUrlRest)
			.get('/Related/?id==2&select(id,name)')
			.set(headers)
			.expect((r) => assert.ok(r.body[0].id == '2'))
			.expect(200);
	});

	it('[rest] Query by var nullable', async () => {
		const response = await request(envUrlRest)
			.get('/SubObject/?any==any-2&select(id,any)')
			.set(headers)
			.expect((r) => assert.ok(r.body[0].id == '2'))
			.expect(200);
	});

	it('[rest] Query by var with null var', async () => {
		const response = await request(envUrlRest)
			.get('/SubObject/?any==null&select(id,any)')
			.set(headers)
			.expect((r) => assert.ok(r.body[0].id == '0'))
			.expect((r) => assert.ok(r.body[0].any == null))
			.expect(200);
	});

	it('[rest] Query by nested attribute', async () => {
		const response = await request(envUrlRest)
			.get('/SubObject/?related.name==name-2&select(id,any)')
			.set(headers)
			.expect((r) => assert.ok(r.body[0].id == '2'))
			.expect(200);
	});

	it('[rest] Query by multiple nested attributes', async () => {
		const response = await request(envUrlRest)
			.get('/SubObject/?any==any-2&related.name==name-2&select(id,any)')
			.set(headers)
			.expect((r) => assert.ok(r.body[0].id == '2'))
			.expect(200);
	});

	it('[rest] Query by nested attribute primary key', async () => {
		const response = await request(envUrlRest)
			.get('/SubObject/?related.id==2&select(id,any)')
			.set(headers)
			.expect((r) => assert.ok(r.body[0].id == '2'))
			.expect(200);
	});

	it('[rest] Query by doubly nested attribute', async () => {
		const response = await request(envUrlRest)
			.get('/SubObject/?related.subObject.any==any-2&select(id,any)')
			.set(headers)
			.expect((r) => assert.ok(r.body[0].id == '2'))
			.expect(200);
	});

	it('[rest] Query with nested fragments', async () => {
		const response = await request(envUrlRest)
			.get('/Related/?id==3')
			.set(headers)
			.expect((r) => assert.ok(r.body[0].id == '3'))
			.expect(200);
	});
});
