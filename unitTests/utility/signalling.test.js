'use strict';

const assert = require('node:assert');
const chai = require('chai');
const sinon = require('sinon');
const rewire = require('rewire');
const { expect } = chai;
const sinon_chai = require('sinon-chai').default;
chai.use(sinon_chai);
let itc_utils;
let hdb_logger;
let signalling;

describe('Test signalling module', () => {
	const sandbox = sinon.createSandbox();
	const TEST_ERROR = 'oh no an error';
	let send_itc_event_stub;
	let log_error_stub;

	before(() => {
		hdb_logger = require('#src/utility/logging/harper_logger');
		log_error_stub = sandbox.stub(hdb_logger, 'error');
		sandbox.stub(hdb_logger, 'trace');
		itc_utils = require('#js/server/threads/itc');
		send_itc_event_stub = sandbox.stub(itc_utils, 'sendItcEvent');
		signalling = rewire('#src/utility/signalling');
	});

	afterEach(() => {
		send_itc_event_stub.returns();
		sandbox.resetHistory();
	});

	after(() => {
		sandbox.restore();
		rewire('#src/utility/signalling');
	});

	it('Test signalSchemaChange happy path', () => {
		const message = {
			operation: 'create_schema',
			schema: 'unit_test',
		};
		const expected_event = {
			type: 'schema',
			message: {
				operation: 'create_schema',
				schema: 'unit_test',
			},
		};
		signalling.signalSchemaChange(message);
		expect(send_itc_event_stub).to.have.been.calledWith(sinon.match(expected_event));
	});

	it('Test signalSchemaChange sad path', async () => {
		send_itc_event_stub.throws(TEST_ERROR);
		await signalling.signalSchemaChange('message');
		expect(log_error_stub.lastCall.args[0].name).to.equal(TEST_ERROR);
	});

	it('propagates a restore close barrier failure', async () => {
		send_itc_event_stub.rejects(new Error('restore barrier timed out'));
		await assert.rejects(
			signalling.signalSchemaChange({ operation: 'restore_backup', restorePhase: 'close' }),
			/restore barrier timed out/
		);
	});

	it('Test signalUserChange happy path', () => {
		const message = 'user';
		const expected_event = {
			type: 'user',
			message: 'user',
		};
		signalling.signalUserChange(message);
		expect(send_itc_event_stub).to.have.been.calledWith(sinon.match(expected_event));
	});

	it('Test signalUserChange sad path', () => {
		send_itc_event_stub.throws(TEST_ERROR);
		signalling.signalUserChange('message');
		expect(log_error_stub.lastCall.args[0].name).to.equal(TEST_ERROR);
	});
});
