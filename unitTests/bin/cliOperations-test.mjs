import { expect } from 'chai';
import sinon from 'sinon';
import fs from 'fs-extra';
import { setupTestApp } from '../apiTests/setupTestApp.mjs';
import { buildRequest, cliOperations } from '../../bin/cliOperations.js';

describe('test CLI operations', () => {
	let available_records;
	let sandbox;
	let log_spy;
	let error_log_spy;

	before(async function () {
		sandbox = sinon.createSandbox();
		this.timeout(5000);
		available_records = await setupTestApp();
		sandbox.stub(fs, 'exists').resolves(true);
		log_spy = sandbox.spy(console, 'log');
		error_log_spy = sandbox.spy(console, 'error');
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		sandbox.restore();
	});

	it('Test describe_table returns the table', async () => {
		process.argv.push('describe_table', 'table=SimpleRecord');
		const cli_api_op = buildRequest();
		await cliOperations(cli_api_op);
		expect(log_spy.args[0][0]).to.equal(
			'schema: data\n' +
				'name: SimpleRecord\n' +
				'hash_attribute: id\n' +
				'audit: true\n' +
				'schema_defined: true\n' +
				'attributes:\n' +
				'  - attribute: id\n' +
				'    type: ID\n' +
				'    is_primary_key: true\n' +
				'  - attribute: name\n' +
				'    type: String\n' +
				'    indexed: true\n' +
				'clustering_stream_name: 1de711100ea42452f25b5e71cc5bcc61\n' +
				'record_count: 0'
		);
		process.argv.splice(process.argv.indexOf('describe_table'), 1);
		process.argv.splice(process.argv.indexOf('table=SimpleRecord'), 1);
	});

	it('Test describe_all when the table doesnt exist', async () => {
		process.argv.push('describe_table', 'table=not-there');
		const cli_api_op = buildRequest();
		await cliOperations(cli_api_op);
		expect(error_log_spy.args[0][0]).to.equal("Error: Table 'data.not-there' does not exist");
		process.argv.splice(process.argv.indexOf('describe_table'), 1);
		process.argv.splice(process.argv.indexOf('table=not-there'), 1);
	});

	it('Test SQL query', async () => {
		const test_array = ['sql', 'sql=select * from data.FourProp'];
		process.argv.push(...test_array);
		const cli_api_op = buildRequest();
		await cliOperations(cli_api_op);
		expect(log_spy.args[0][0]).to.include('id: "0"');
		expect(log_spy.args[0][0]).to.include('id: "1"');
		expect(log_spy.args[0][0]).to.include('id: "2"');
		expect(log_spy.args[0][0]).to.include('id: "3"');
		expect(log_spy.args[0][0]).to.include('id: "4"');
		expect(log_spy.args[0][0]).to.include('id: "5"');
		expect(log_spy.args[0][0]).to.include('id: "6"');
		expect(log_spy.args[0][0]).to.include('id: "7"');
		expect(log_spy.args[0][0]).to.include('id: "8"');
		expect(log_spy.args[0][0]).to.include('id: "9"');
		process.argv.splice(process.argv.indexOf('sql'), 1);
		process.argv.splice(process.argv.indexOf('sql=select * from data.FourProp'), 1);
	});

	it('Test search_by_id returns a record', async () => {
		const test_array = [
			'search_by_id',
			'database=data',
			'table=FourProp',
			'ids=["1"]',
			'get_attributes=["*"]',
			'json=true',
		];
		process.argv.push(...test_array);
		const cli_api_op = buildRequest();
		await cliOperations(cli_api_op);
		expect(log_spy.args[0][0]).to.equal(
			'[\n  {\n    "id": "1",\n    "name": "name1",\n    "age": 21,\n    "birthday": "1991-03-22T22:41:12.176Z",\n    "title": "title1"\n  }\n]'
		);
	});
});
