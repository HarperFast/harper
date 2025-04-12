'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const rewire = require('rewire');
const cluster_utils = require('../../../utility/clustering/clusterUtilities');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const pm2_utils = require('../../../utility/processManagement/processManagement');
const hdb_log = require('../../../utility/logging/harper_logger');
const hdb_utils = require('../../../utility/common_utils');
const update_nodes4_0_0 = rewire('../../../upgrade/nats/updateNodes4-0-0');

const TENS_DAYS_IN_MS = 864000000;

describe.skip('Test updateNodes4-0-0 module', () => {
	const sandbox = sinon.createSandbox();
	const test_node_record = [
		{
			__createdtime__: 1658154668061,
			__updatedtime__: Date.now(),
			host: '18.224.68.187',
			name: 'conveyor_1',
			operation: null,
			port: 12345,
			subscriptions: [
				{
					schema: 'bearing_1',
					table: 'speed',
					publish: true,
					subscribe: false,
				},
				{
					schema: 'bearing_1',
					table: 'hours',
					publish: true,
					subscribe: true,
				},
			],
			system_info: {
				hdb_version: '3.x.x',
			},
		},
		{
			__createdtime__: 1658154668061,
			__updatedtime__: Date.now(),
			host: '18.224.68.187',
			name: 'conveyor_2',
			operation: null,
			port: 12345,
			subscriptions: [
				{
					schema: 'bearing_1',
					table: 'speed',
					publish: true,
					subscribe: false,
				},
			],
			system_info: {
				hdb_version: '3.x.x',
			},
		},
	];
	const add_node_stub = sandbox.stub();
	const remove_node_stub = sandbox.stub();
	let update_node;
	let nats_request_stub;
	let upsert_node_record_stub;
	let delete_process_stub;
	let hdb_log_trace_stub;
	let async_timeout_stub;

	before(() => {
		sandbox.stub(cluster_utils, 'getAllNodeRecords').resolves(test_node_record);
		nats_request_stub = sandbox
			.stub(nats_utils, 'request')
			.resolves({ status: 'open', message: { system_info: { hdb_version: '4.0.0' } } });
		upsert_node_record_stub = sandbox.stub(cluster_utils, 'upsertNodeRecord');
		delete_process_stub = sandbox.stub(pm2_utils, 'deleteProcess');
		hdb_log_trace_stub = sandbox.stub(hdb_log, 'trace');
		async_timeout_stub = sandbox.stub(hdb_utils, 'async_set_timeout').resolves();
		update_nodes4_0_0.__set__('remove_node', remove_node_stub);
	});

	after(() => {
		sandbox.restore();
		rewire('../../../upgrade/nats/updateNodes4-0-0');
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test node returns open status and is added happy path', async () => {
		const add_node_rw = update_nodes4_0_0.__set__('add_node', add_node_stub);
		const test_req = {
			__createdtime__: 1658154668061,
			__updatedtime__: Date.now(),
			host: '18.224.68.187',
			name: 'conveyor_1',
			operation: null,
			port: 12345,
			subscriptions: [
				{
					schema: 'bearing_1',
					table: 'speed',
					publish: true,
					subscribe: false,
				},
				{
					schema: 'bearing_1',
					table: 'hours',
					publish: true,
					subscribe: true,
				},
			],
			system_info: {
				hdb_version: '3.x.x',
			},
		};
		update_node = update_nodes4_0_0.__get__('updateNode');
		await update_node(test_req);
		expect(add_node_stub.args[0][0]).to.eql({
			operation: 'add_node',
			node_name: 'conveyor_1',
			subscriptions: [
				{
					schema: 'bearing_1',
					table: 'speed',
					publish: true,
					subscribe: false,
				},
				{
					schema: 'bearing_1',
					table: 'hours',
					publish: true,
					subscribe: true,
				},
			],
		});
		add_node_rw();
	});

	it('Test node is not added and days dif is adjusted', async () => {
		const add_node_rw = update_nodes4_0_0.__set__('add_node', add_node_stub);
		const test_req = {
			__createdtime__: 1658154668061,
			__updatedtime__: Date.now() - TENS_DAYS_IN_MS,
			host: '18.224.68.187',
			name: 'conveyor_2',
			operation: null,
			port: 12345,
			subscriptions: [
				{
					schema: 'bearing_1',
					table: 'speed',
					publish: true,
					subscribe: false,
				},
			],
			system_info: {
				hdb_version: '3.x.x',
			},
		};
		update_node = update_nodes4_0_0.__get__('updateNode');
		nats_request_stub.resolves({ status: 'error', message: { system_info: { hdb_version: '3.x.x' } } });
		await update_node(test_req);
		expect(add_node_stub.called).to.be.false;
		expect(Math.floor(hdb_log_trace_stub.args[1][1])).to.equal(10);
		expect(remove_node_stub.args[0][0]).to.eql({
			operation: 'remove_node',
			node_name: 'conveyor_2',
		});
		add_node_rw();
	});
});
