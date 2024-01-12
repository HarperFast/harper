'use strict';

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const test_utils = require('../test_utils');
const { addUpdateNodeValidator } = require('../../validation/clustering/addUpdateNodeValidator');

describe('Test addUpdateNodeValidator module', () => {
	const sandbox = sinon.createSandbox();

	after(() => {
		sandbox.restore();
	});

	it('Test validator catches errors on all params', () => {
		const test_req = {
			operation: 'add_noodle',
			node_name: 'dev.cow',
			subscriptions: [
				{
					table: 'test_table',
					schema: 'test_schema',
					subscribe: 'yes',
					publish: 'no',
				},
				{
					table: 'test_table2',
					schema: 'test_schema2',
					subscribe: true,
					publish: false,
				},
			],
		};

		const result = addUpdateNodeValidator(test_req);
		expect(result.message).to.equal(
			"'operation' must be one of [add_node, update_node, set_node_replication]. 'node_name' invalid, must not contain ., * or >. 'subscriptions[0].subscribe' must be a boolean. 'subscriptions[0].publish' must be a boolean"
		);
	});

	it('Test invalid schema name message returned', () => {
		test_utils.setGlobalSchema('name', 'breed', 'test_table', ['name', 'age']);
		const test_req = {
			operation: 'add_node',
			node_name: 'dev_cow',
			subscriptions: [
				{
					schema: 'system',
					table: 'test_table',
					subscribe: true,
				},
			],
		};

		const result = addUpdateNodeValidator(test_req);
		expect(result.message).to.equal("'subscriptions[0].publish' is required");
	});

	it('Test two false subs returns error', () => {
		test_utils.setGlobalSchema('name', 'breed', 'test_table', ['name', 'age']);
		const test_req = {
			operation: 'add_node',
			node_name: 'dev_cow',
			subscriptions: [
				{
					schema: 'breed',
					table: 'test_table',
					subscribe: false,
					publish: false,
				},
			],
		};

		const result = addUpdateNodeValidator(test_req);
		expect(result.message).to.equal(
			"'subscriptions[0]' subscribe and/or publish must be set to true when adding a node"
		);
	});
});
