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
		send_itc_event_stub.resetBehavior();
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

	it('strictly quiesces job workers and stops renewal when aborted', async () => {
		send_itc_event_stub.resolves();
		const localSchemaHandler = sandbox.stub().callsFake(async (event) => {
			const resultByPhase = {
				'hold-worker-starts': 'held',
				'quiesce': 'quiesced',
				'abort-quiesce': 'aborted',
				'release-worker-starts': 'released',
			};
			return { [resultByPhase[event.message.phase]]: true };
		});
		const restoreHandlers = signalling.__set__('serverItcHandlers', { schema: localSchemaHandler });
		try {
			const message = await signalling.quiesceSchemaChange({
				operation: 'drop_table',
				schema: 'unit_test',
				table: 'records',
			});
			const quiesceCall = send_itc_event_stub.getCalls().find((call) => call.args[0].message.phase === 'quiesce');
			expect(quiesceCall.args[1].includeJobWorkers).to.equal(true);
			expect(quiesceCall.args[1].acceptResult({ quiesced: true })).to.equal(true);
			await signalling.abortSchemaQuiesce(message);
			const abortCall = send_itc_event_stub.getCalls().find((call) => call.args[0].message.phase === 'abort-quiesce');
			expect(abortCall.args[1].includeJobWorkers).to.equal(true);
			expect(abortCall.args[1].acceptResult({ aborted: true })).to.equal(true);
		} finally {
			restoreHandlers();
		}
	});

	it('retries strict terminal finalization and requires explicit worker results', async () => {
		const localSchemaHandler = sandbox.stub().resolves({ finalized: true });
		const restoreHandlers = signalling.__set__('serverItcHandlers', { schema: localSchemaHandler });
		send_itc_event_stub.onFirstCall().rejects(new Error('first terminal failure'));
		send_itc_event_stub.onSecondCall().rejects(new Error('second terminal failure'));
		send_itc_event_stub.onThirdCall().resolves();
		send_itc_event_stub.onCall(3).resolves();
		try {
			await signalling.finalizeSchemaChange({
				operation: 'drop_schema',
				schema: 'unit_test',
				quiesceId: 'q-final',
			});
			expect(localSchemaHandler.firstCall.args[0].message.phase).to.equal('finalize-quiesce');
			const terminalCalls = send_itc_event_stub
				.getCalls()
				.filter((call) => call.args[0].message.phase === 'finalize-quiesce');
			expect(terminalCalls).to.have.length(3);
			for (const call of terminalCalls) {
				const options = call.args[1];
				expect(options.includeJobWorkers).to.equal(true);
				expect(options.acceptResult({ finalized: true })).to.equal(true);
			}
		} finally {
			restoreHandlers();
		}
	});

	it('requires explicit reconciliation results from local and job workers', async () => {
		const localSchemaHandler = sandbox.stub().resolves({ reconciled: true });
		const restoreHandlers = signalling.__set__('serverItcHandlers', { schema: localSchemaHandler });
		send_itc_event_stub.resolves();
		try {
			await signalling.reconcileSchemaChange({
				operation: 'drop_table',
				schema: 'unit_test',
				table: 'records',
				quiesceId: 'q-reconcile',
			});
			const event = localSchemaHandler.firstCall.args[0];
			expect(event.message.phase).to.equal('reconcile-quiesce');
			const terminalCall = send_itc_event_stub
				.getCalls()
				.find((call) => call.args[0].message.phase === 'reconcile-quiesce');
			const options = terminalCall.args[1];
			expect(options.includeJobWorkers).to.equal(true);
			expect(options.acceptResult({ reconciled: true })).to.equal(true);
			expect(options.acceptResult({ finalized: true })).to.equal(false);
		} finally {
			restoreHandlers();
		}
	});

	it('reconciles and releases the worker barrier after a partial commit failure', async () => {
		const localSchemaHandler = sandbox.stub().callsFake(async (event) => {
			if (event.message.phase === 'commit-quiesce') return { committed: true };
			if (event.message.phase === 'reconcile-quiesce') return { reconciled: true };
			if (event.message.phase === 'release-worker-starts') return { released: true };
		});
		const restoreHandlers = signalling.__set__('serverItcHandlers', { schema: localSchemaHandler });
		const message = {
			operation: 'drop_table',
			schema: 'unit_test',
			table: 'records',
			quiesceId: 'q-partial-commit',
		};
		send_itc_event_stub.rejects(new Error('commit acknowledgement lost'));
		try {
			let commitError;
			try {
				await signalling.commitSchemaChange(message);
			} catch (error) {
				commitError = error;
			}
			expect(commitError).to.exist;
			expect(
				localSchemaHandler.getCalls().some((call) => call.args[0].message.phase === 'release-worker-starts')
			).to.equal(false);
			send_itc_event_stub.resolves();
			await signalling.reconcileSchemaChange(message);
			expect(
				localSchemaHandler.getCalls().some((call) => call.args[0].message.phase === 'release-worker-starts')
			).to.equal(true);
		} finally {
			restoreHandlers();
		}
	});
});
