'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const rewire = require('rewire');
const env_manager = require('../../../utility/environment/environmentManager');
const nats_utils = require('../../../server/nats/utility/natsUtils');
const InsertObject = require('../../../dataLayer/InsertObject');
const UpdateObject = require('../../../dataLayer/UpdateObject');
const UpsertObject = require('../../../dataLayer/UpsertObject');
const DeleteObject = require('../../../dataLayer/DeleteObject');
const CreateAttributeObject = require('../../../dataLayer/CreateAttributeObject');
const transactToClusteringUtilities = rewire('../../../utility/clustering/transactToClusteringUtilities');

const USER = {
	username: 'HDB_ADMIN',
};

const INSERT_OP = new InsertObject('dev', 'dog', 'id', [{ id: 1, name: 'Penny', weight: '70lbs' }]);
INSERT_OP.hdb_user = USER;

const UPDATE_OP = new UpdateObject('dev', 'dog', [{ id: 1, name: 'Penny B', age: 8 }]);
UPDATE_OP.hdb_user = USER;

const UPSERT_OP = new UpsertObject('dev', 'dog', [{ id: 1, name: 'Penny', age: 8 }]);
UPSERT_OP.hdb_user = USER;

const DELETE_OP = new DeleteObject('dev', 'dog', [1, 5]);
DELETE_OP.hdb_user = USER;

const ATTRIBUTE_OP = new CreateAttributeObject('dev', 'cow', 'favourite moozic');
ATTRIBUTE_OP.hdb_user = USER;

// we don't use transactToClustering anymore
describe.skip('Test transactToClusteringUtilities module', () => {
	const sandbox = sinon.createSandbox();
	let publish_to_stream_stub;

	before(() => {
		publish_to_stream_stub = sandbox.stub(nats_utils, 'publishToStream');
		env_manager.setProperty('node_name', 'test-node');
		env_manager.setProperty('clustering_enabled', true);
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	it('Test sendOperationTransaction calls nats publish to stream with correct params', async () => {
		const expected_transaction = {
			operation: 'upsert',
			schema: 'dev',
			table: 'dog',
			__origin: 'node1',
			records: [
				{
					id: 1,
					name: 'Penny',
					age: 8,
				},
			],
		};
		const sendOperationTransaction = transactToClusteringUtilities.__get__('sendOperationTransaction');
		await sendOperationTransaction(UPSERT_OP, [1, 2, 3], 'node1');
		expect(publish_to_stream_stub.getCall(0).args[0]).to.equal('txn.dev.dog');
		expect(publish_to_stream_stub.getCall(0).args[1]).to.equal('9d2969dfab3c9b5daa6f8d3d0b3ad347');
		expect(publish_to_stream_stub.getCall(0).args[2]).to.be.undefined;
		expect(publish_to_stream_stub.getCall(0).args[3]).to.eql(expected_transaction);
	});

	it('Test convertCRUDOperationToTransaction happy path when called with delete', () => {
		const expected_transaction = {
			__origin: 'node1',
			hash_values: [1, 5],
			operation: 'delete',
			schema: 'dev',
			table: 'dog',
		};
		const convertCRUDOperationToTransaction = transactToClusteringUtilities.__get__(
			'convertCRUDOperationToTransaction'
		);
		const result = convertCRUDOperationToTransaction(DELETE_OP, [1, 5], 'node1');
		expect(result).to.eql(expected_transaction);
	});

	it('Test convertCRUDOperationToTransaction happy path when called not delete', () => {
		const expected_transaction = {
			__origin: 'node1',
			operation: 'update',
			records: [
				{
					age: 8,
					id: 1,
					name: 'Penny B',
				},
			],
			schema: 'dev',
			table: 'dog',
		};
		const convertCRUDOperationToTransaction = transactToClusteringUtilities.__get__(
			'convertCRUDOperationToTransaction'
		);
		const result = convertCRUDOperationToTransaction(UPDATE_OP, [1], 'node1');
		expect(result).to.eql(expected_transaction);
	});

	describe('Test postOperationHandler function', () => {
		const { postOperationHandler } = transactToClusteringUtilities;
		let send_operation_transaction_stub = sandbox.stub();
		let send_operation_transaction_rw;

		before(() => {
			send_operation_transaction_rw = transactToClusteringUtilities.__set__(
				'sendOperationTransaction',
				send_operation_transaction_stub
			);
		});

		after(() => {
			send_operation_transaction_rw();
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		it('Test insert', async () => {
			await postOperationHandler(INSERT_OP, { inserted_hashes: [1] });
			expect(send_operation_transaction_stub.calledOnce).to.be.true;
		});

		it('Test delete', async () => {
			await postOperationHandler(DELETE_OP, { deleted_hashes: [1] });
			expect(send_operation_transaction_stub.calledOnce).to.be.true;
		});

		it('Test update', async () => {
			await postOperationHandler(UPDATE_OP, { update_hashes: [1] });
			expect(send_operation_transaction_stub.calledOnce).to.be.true;
		});

		it('Test upsert', async () => {
			await postOperationHandler(UPDATE_OP, { upserted_hashes: [1] });
			expect(send_operation_transaction_stub.calledOnce).to.be.true;
		});
	});
});
