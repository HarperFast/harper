'use strict';

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

	it('Test signalSchemaChange sad path', () => {
		send_itc_event_stub.throws(TEST_ERROR);
		signalling.signalSchemaChange('message');
		expect(log_error_stub.lastCall.args[0].name).to.equal(TEST_ERROR);
	});

	it('broadcasts a peer-first schema completion twice when requested', async () => {
		const message = {
			operation: 'drop_schema',
			schema: 'late_joining_worker_test',
			dropPreparationId: 'late-join-test',
		};

		await signalling.signalSchemaChange(message, {
			peersFirst: true,
			includeJobWorkers: true,
			peerRounds: 2,
		});

		expect(send_itc_event_stub).to.have.been.calledTwice;
		expect(send_itc_event_stub).to.always.have.been.calledWith(sinon.match({ message }), true);
	});
});
