'use strict';

const { assert, expect } = globalThis.chai || require('chai');
const { callOperation, removeAllSchemas } = require('../utility');
const crypto = require('crypto');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

describe('test schema operations', () => {
	beforeEach(async () => {
		await removeAllSchemas();
	});

	it('describes all schemas and expect empty object', async () => {
		let response = await callOperation({
			operation: 'describe_all',
		});
		expect(response.status).to.eq(200);
		let body = await response.json();
		expect(body).to.eql({});
	});

	it('call describe_schema with no schema. expect error', async () => {
		let response = await callOperation({
			operation: 'describe_schema',
		});
		expect(response.status).to.eq(500);
		let body = await response.json();
		expect(body).to.eql({ error: 'Schema is required' });
	});

	it('call describe_schema with schema that does not exist. expect error', async () => {
		let response = await callOperation({
			operation: 'describe_schema',
			schema: 'blerg',
		});
		expect(response.status).to.eq(404);
		let body = await response.json();
		expect(body).to.eql({ error: "Schema 'blerg' does not exist" });
	});

	it('call describe_table with no schema or table. expect error', async () => {
		let response = await callOperation({
			operation: 'describe_table',
		});
		expect(response.status).to.eq(500);
		let body = await response.json();
		//TODO change this error once CORE-1976 is fixed
		expect(body).to.eql({
			error: 'Schema is required,Table is required',
		});

		response = await callOperation({
			operation: 'describe_table',
			schema: 'blerg',
		});
		expect(response.status).to.eq(500);
		body = await response.json();
		//TODO change this error once CORE-1976 is fixed
		expect(body).to.eql({
			error: 'Table is required',
		});
	});

	it('create 1 schema and describe_all / describe_table should return it back ', async () => {
		let response = await callOperation({
			operation: 'create_schema',
			schema: 'dev',
		});
		expect(response.status).to.eq(200);
		let body = await response.json();
		expect(body).to.eql({ message: "schema 'dev' successfully created" });

		response = await callOperation({
			operation: 'describe_schema',
			schema: 'dev',
		});
		expect(response.status).to.eq(200);
		body = await response.json();
		expect(body).to.eql({});

		response = await callOperation({
			operation: 'describe_all',
		});
		expect(response.status).to.eq(200);
		body = await response.json();
		expect(body).to.eql({ dev: {} });
	});

	it('create 1 schema and 1 table describe_all / describe_table should return it back ', async () => {
		let response = await callOperation({
			operation: 'create_schema',
			schema: 'dev',
		});
		expect(response.status).to.eq(200);
		let body = await response.json();
		expect(body).to.eql({ message: "schema 'dev' successfully created" });

		response = await callOperation({
			operation: 'describe_schema',
			schema: 'dev',
		});
		expect(response.status).to.eq(200);
		body = await response.json();
		expect(body).to.eql({});

		response = await callOperation({
			operation: 'describe_all',
		});
		expect(response.status).to.eq(200);
		body = await response.json();
		expect(body).to.eql({ dev: {} });
	});

	it('create_schema with no schema. expect error', async () => {
		let response = await callOperation({
			operation: 'create_schema',
		});
		expect(response.status).to.eq(400);
		let body = await response.json();
		expect(body).to.eql({ error: 'Schema is required' });
	});

	it('create_schema with schema is a number. ', async () => {
		let response = await callOperation({
			operation: 'create_schema',
			schema: 1234,
		});
		expect(response.status).to.eq(200);
		let body = await response.json();
		expect(body).to.eql({ message: "schema '1234' successfully created" });
	});

	it('create_table with no schema, no table, no hash_attribute. expect error', async () => {
		let response = await callOperation({
			operation: 'create_table',
		});
		expect(response.status).to.eq(400);
		let body = await response.json();
		expect(body).to.eql({ error: 'Schema is required,Table is required,Hash attribute is required' });

		response = await callOperation({
			operation: 'create_table',
			schema: 'dev',
		});
		expect(response.status).to.eq(400);
		body = await response.json();
		expect(body).to.eql({ error: 'Table is required,Hash attribute is required' });

		response = await callOperation({
			operation: 'create_table',
			schema: 'dev',
			table: 'test',
		});
		expect(response.status).to.eq(400);
		body = await response.json();
		expect(body).to.eql({ error: 'Hash attribute is required' });
	});

	it('create_table when schema does not exist. expect error', async () => {
		let response = await callOperation({
			operation: 'create_table',
			schema: 'dev',
			table: 'test',
			hash_attribute: 'id',
		});
		expect(response.status).to.eq(404);
		let body = await response.json();
		expect(body).to.eql({ error: "Schema 'dev' does not exist" });
	});

	it('create_table and verify it exists.', async () => {
		let response = await callOperation({
			operation: 'create_schema',
			schema: 'dev',
		});
		expect(response.status).to.eq(200);
		let body = await response.json();
		expect(body).to.eql({ message: "schema 'dev' successfully created" });

		response = await callOperation({
			operation: 'create_table',
			schema: 'dev',
			table: 'test',
			hash_attribute: 'id',
		});
		expect(response.status).to.eq(200);
		body = await response.json();
		expect(body).to.eql({ message: "table 'dev.test' successfully created." });

		response = await callOperation({
			operation: 'describe_schema',
			schema: 'dev',
		});
		expect(response.status).to.eq(200);
		body = await response.json();
		expect(body.test.attributes).to.have.deep.members([
			{
				attribute: '__createdtime__',
			},
			{
				attribute: 'id',
			},
			{
				attribute: '__updatedtime__',
			},
		]);

		expect(body.test).to.include({
			hash_attribute: 'id',
			name: 'test',
			record_count: 0,
			schema: 'dev',
			clustering_stream_name: crypto.createHash('md5').update(`dev.test`).digest('hex'),
		});
	});

	it('create_attribute with no schema, table, attribute', async () => {
		let response = await callOperation({
			operation: 'create_attribute',
		});

		expect(response.status).to.eq(400);
		let body = await response.json();

		expect(body).to.eql({
			error: 'Schema is required,Table is required,Attribute is required',
		});

		response = await callOperation({
			operation: 'create_attribute',
			schema: 'blerg',
		});
		expect(response.status).to.eq(400);
		body = await response.json();

		expect(body).to.eql({
			error: 'Table is required,Attribute is required',
		});

		response = await callOperation({
			operation: 'create_attribute',
			schema: 'blerg',
			table: 'test',
		});
		expect(response.status).to.eq(400);
		body = await response.json();

		expect(body).to.eql({
			error: 'Attribute is required',
		});
	});

	it('test create_attribute with no-existent schema', async () => {
		let response = await callOperation({
			operation: 'create_attribute',
			schema: 'dev',
			table: 'blerg',
			attribute: 'name',
		});
		expect(response.status).to.eq(404);
		let body = await response.json();

		expect(body).to.eql({
			error: "Schema 'dev' does not exist",
		});
	});

	it('test create_attribute with no-existent table', async () => {
		let response = await callOperation({
			operation: 'create_schema',
			schema: 'dev',
		});
		expect(response.status).to.eq(200);
		let body = await response.json();
		expect(body).to.eql({
			message: "schema 'dev' successfully created",
		});

		response = await callOperation({
			operation: 'create_attribute',
			schema: 'dev',
			table: 'blerg',
			attribute: 'name',
		});
		expect(response.status).to.eq(404);
		body = await response.json();

		expect(body).to.eql({
			error: "Table 'dev.blerg' does not exist",
		});
	});

	it('test create_attribute happy path', async () => {
		let response = await callOperation({
			operation: 'create_schema',
			schema: 'dev',
		});
		expect(response.status).to.eq(200);
		let body = await response.json();
		expect(body).to.eql({
			message: "schema 'dev' successfully created",
		});
		await sleep(10);
		response = await callOperation({
			operation: 'create_table',
			schema: 'dev',
			table: 'test',
			hash_attribute: 'id',
		});
		expect(response.status).to.eq(200);
		body = await response.json();
		expect(body).to.eql({
			message: "table 'dev.test' successfully created.",
		});
		await sleep(10);
		response = await callOperation({
			operation: 'create_attribute',
			schema: 'dev',
			table: 'test',
			attribute: 'name',
		});
		expect(response.status).to.eq(200);
		body = await response.json();

		expect(body).to.eql({
			message: "attribute 'dev.test.name' successfully created.",
		});

		response = await callOperation({
			operation: 'describe_table',
			schema: 'dev',
			table: 'test',
		});
		expect(response.status).to.eq(200);
		body = await response.json();

		expect(body.attributes).to.have.deep.members([
			{ attribute: 'name' },
			{
				attribute: '__createdtime__',
			},
			{
				attribute: 'id',
			},
			{
				attribute: '__updatedtime__',
			},
		]);
	});
});
