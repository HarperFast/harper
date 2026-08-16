'use strict';

const chai = require('chai');
const sinon = require('sinon');
const rewire = require('rewire');
const { expect } = chai;
const sinon_chai = require('sinon-chai').default;
chai.use(sinon_chai);
const harper_logger = require('#src/utility/logging/harper_logger');
const user_schema = require('#src/security/user');
const harperBridge = require('#src/dataLayer/harperBridge/harperBridge').default;
// Note: rewire is used to access private functions (schemaHandler, userHandler, componentStatusRequestHandler)
// for testing validation logic, not for replacing dependencies with mocks
const server_itc_handlers = rewire('#js/server/itc/serverHandlers');
const { resetResources } = require('#src/resources/Resources');

describe('Test hdbChildIpcHandler module', () => {
	const TEST_ERR = 'The roof is on fire';
	const sandbox = sinon.createSandbox();
	let log_error_stub;
	let log_trace_stub;

	before(() => {
		log_error_stub = sandbox.stub(harper_logger, 'error');
		sandbox.stub(harper_logger, 'info');
		log_trace_stub = sandbox.stub(harper_logger, 'trace');
		sandbox.stub(harper_logger, 'warn');
		sandbox.stub(harper_logger, 'debug');
	});

	after(() => {
		sandbox.restore();
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	describe('Test user event handler function', () => {
		let user_handler;

		before(() => {
			user_handler = server_itc_handlers.__get__('userHandler');
		});

		// Tests error handling: verifies errors from setUsersWithRolesCache are caught and logged
		it('Test User Handler log error upon setUsersWithRolesCache failure', async () => {
			const setUserStub = sandbox.stub(user_schema, 'setUsersWithRolesCache').throws({ name: TEST_ERR });
			const test_event = {
				type: 'user',
				message: { originator: 12345 },
			};
			await user_handler(test_event);
			// Verify the specific error was logged (not just any error)
			expect(log_error_stub.args[0][0].name).to.equal(TEST_ERR);
			setUserStub.restore();
		});

		// Tests validation: verifies valid events pass validation and reach the cache update
		it('Test User Handler calls setUsersWithRolesCache on valid event', async () => {
			const setUserStub = sandbox.stub(user_schema, 'setUsersWithRolesCache').resolves();
			const resetReadTxnStub = sandbox.stub(harperBridge, 'resetReadTxn');
			const test_event = {
				type: 'user',
				message: { originator: 12345 },
			};
			await user_handler(test_event);
			// Verifies validation passed and handler proceeded to update cache
			expect(setUserStub).to.have.been.calledOnce;
			setUserStub.restore();
			resetReadTxnStub.restore();
		});

		// Tests validation: invalid events should be rejected and logged
		it('Test User Handler logs error on invalid event (missing type)', async () => {
			const test_event = {
				message: { originator: 12345 },
			};
			await user_handler(test_event);
			expect(log_error_stub).to.have.been.called;
		});

		// Tests validation: invalid events should be rejected and logged
		it('Test User Handler logs error on invalid event (missing message)', async () => {
			const test_event = {
				type: 'user',
			};
			await user_handler(test_event);
			expect(log_error_stub).to.have.been.called;
		});

		// Tests listener registration: verifies addListener actually registers callbacks
		it('Test User Handler addListener functionality', async () => {
			const setUserStub = sandbox.stub(user_schema, 'setUsersWithRolesCache').resolves();
			const resetReadTxnStub = sandbox.stub(harperBridge, 'resetReadTxn');
			let listenerCalled = false;
			user_handler.addListener(() => {
				listenerCalled = true;
			});
			const test_event = {
				type: 'user',
				message: { originator: 12345 },
			};
			await user_handler(test_event);
			// Verifies registered listener was actually invoked
			expect(listenerCalled).to.be.true;
			setUserStub.restore();
			resetReadTxnStub.restore();
		});
	});

	describe('Test schema event handler function', () => {
		let schema_handler;

		before(() => {
			schema_handler = server_itc_handlers.__get__('schemaHandler');
		});

		// Tests validation: invalid events should be rejected and logged
		it('Test Schema Handler logs error on invalid event (missing type)', async () => {
			const test_event = {
				message: { originator: 12345, operation: 'create_table', schema: 'test' },
			};
			await schema_handler(test_event);
			expect(log_error_stub).to.have.been.called;
		});

		// Tests validation: invalid events should be rejected and logged
		it('Test Schema Handler logs error on invalid event (missing message)', async () => {
			const test_event = {
				type: 'schema',
			};
			await schema_handler(test_event);
			expect(log_error_stub).to.have.been.called;
		});

		it('returns the explicit quiesce result without resetting databases', async () => {
			const expectedResult = { quiesced: true };
			const quiesceStub = sandbox.stub().resolves(expectedResult);
			const cleanStub = sandbox.stub().resolves();
			const resetStub = sandbox.stub().returns({});
			const restoreQuiesce = server_itc_handlers.__set__('quiesceSchemaTarget', quiesceStub);
			const restoreClean = server_itc_handlers.__set__('cleanLmdbMap', cleanStub);
			const restoreReset = server_itc_handlers.__set__('resetDatabases', resetStub);
			try {
				const message = {
					originator: 12345,
					operation: 'drop_table',
					phase: 'quiesce',
					schema: 'test',
					table: 'records',
					quiesceId: 'q-1',
				};
				const result = await schema_handler({ type: 'schema', message });
				expect(result).to.equal(expectedResult);
				expect(quiesceStub).to.have.been.calledOnceWithExactly(message);
				expect(cleanStub).not.to.have.been.called;
				expect(resetStub).not.to.have.been.called;
			} finally {
				restoreReset();
				restoreClean();
				restoreQuiesce();
			}
		});

		it('aborts quiescence without resetting databases', async () => {
			const abortStub = sandbox.stub().resolves();
			const cleanStub = sandbox.stub().resolves();
			const resetStub = sandbox.stub().returns({});
			const restoreAbort = server_itc_handlers.__set__('abortSchemaQuiesce', abortStub);
			const restoreClean = server_itc_handlers.__set__('cleanLmdbMap', cleanStub);
			const restoreReset = server_itc_handlers.__set__('resetDatabases', resetStub);
			try {
				const message = {
					originator: 12345,
					operation: 'drop_table',
					phase: 'abort-quiesce',
					schema: 'test',
					table: 'records',
					quiesceId: 'q-2',
				};
				const result = await schema_handler({ type: 'schema', message });
				expect(result).to.deep.equal({ aborted: true });
				expect(abortStub).to.have.been.calledOnceWithExactly(message);
				expect(cleanStub).not.to.have.been.called;
				expect(resetStub).not.to.have.been.called;
			} finally {
				restoreReset();
				restoreClean();
				restoreAbort();
			}
		});

		it('finishes quiescence before the normal database reset', async () => {
			const calls = [];
			const finishStub = sandbox.stub().callsFake(() => calls.push('finish'));
			const cleanStub = sandbox.stub().callsFake(async () => calls.push('clean'));
			const resetStub = sandbox.stub().callsFake(() => {
				calls.push('reset');
				return {};
			});
			const restoreFinish = server_itc_handlers.__set__('finishSchemaQuiesce', finishStub);
			const completeStub = sandbox.stub();
			const restoreComplete = server_itc_handlers.__set__('completeSchemaQuiesce', completeStub);
			const restoreClean = server_itc_handlers.__set__('cleanLmdbMap', cleanStub);
			const restoreReset = server_itc_handlers.__set__('resetDatabases', resetStub);
			try {
				const message = {
					originator: 12345,
					operation: 'drop_table',
					phase: 'finalize-quiesce',
					schema: 'test',
					quiesceId: 'q-3',
				};
				const result = await schema_handler({ type: 'schema', message });
				expect(finishStub).to.have.been.calledOnceWithExactly(message);
				expect(cleanStub).to.have.been.calledOnceWithExactly(message);
				expect(resetStub).to.have.been.calledOnce;
				expect(completeStub).to.have.been.calledOnceWithExactly(message);
				expect(result).to.deep.equal({ finalized: true });
				expect(calls).to.deep.equal(['finish', 'clean', 'reset']);
			} finally {
				restoreReset();
				restoreClean();
				restoreComplete();
				restoreFinish();
			}
		});

		it('coalesces concurrent terminal retries for the same quiescence', async () => {
			let releaseReset;
			const resetBlocked = new Promise((resolve) => (releaseReset = resolve));
			const finishStub = sandbox.stub().returns(true);
			const cleanStub = sandbox.stub().resolves();
			const syncStub = sandbox.stub().callsFake(() => resetBlocked);
			const completeStub = sandbox.stub();
			const restoreFinish = server_itc_handlers.__set__('finishSchemaQuiesce', finishStub);
			const restoreClean = server_itc_handlers.__set__('cleanLmdbMap', cleanStub);
			const restoreSync = server_itc_handlers.__set__('syncSchemaMetadata', syncStub);
			const restoreComplete = server_itc_handlers.__set__('completeSchemaQuiesce', completeStub);
			try {
				const message = {
					originator: 12345,
					operation: 'drop_schema',
					phase: 'finalize-quiesce',
					schema: 'test',
					quiesceId: 'q-concurrent-finalize',
				};
				const first = schema_handler({ type: 'schema', message });
				const retry = schema_handler({ type: 'schema', message });
				releaseReset();
				expect(await Promise.all([first, retry])).to.deep.equal([{ finalized: true }, { finalized: true }]);
				expect(await schema_handler({ type: 'schema', message })).to.deep.equal({ finalized: true });
				expect(finishStub).to.have.been.calledOnceWithExactly(message);
				expect(cleanStub).to.have.been.calledOnceWithExactly(message);
				expect(syncStub).to.have.been.calledOnceWithExactly(message, true);
				expect(completeStub).to.have.been.calledOnceWithExactly(message);
			} finally {
				restoreComplete();
				restoreSync();
				restoreClean();
				restoreFinish();
			}
		});

		it('rejects a mismatched terminal request that reuses a completed ID', async () => {
			const finishStub = sandbox.stub().returns(true);
			const syncStub = sandbox.stub().resolves();
			const restoreFinish = server_itc_handlers.__set__('finishSchemaQuiesce', finishStub);
			const restoreSync = server_itc_handlers.__set__('syncSchemaMetadata', syncStub);
			try {
				const message = {
					originator: 12345,
					operation: 'drop_schema',
					phase: 'finalize-quiesce',
					schema: 'test',
					quiesceId: 'q-terminal-identity',
				};
				expect(await schema_handler({ type: 'schema', message })).to.deep.equal({ finalized: true });
				expect(
					await schema_handler({
						type: 'schema',
						message: { ...message, schema: 'other' },
					})
				).to.deep.equal({ finalized: false });
				expect(finishStub).to.have.been.calledOnce;
				expect(syncStub).to.have.been.calledOnce;
			} finally {
				restoreSync();
				restoreFinish();
			}
		});

		it('bounds retained terminal outcomes', () => {
			const outcomes = server_itc_handlers.__get__('schemaTerminalOutcomes');
			const retain = server_itc_handlers.__get__('retainSchemaTerminalOutcome');
			const maximum = server_itc_handlers.__get__('MAX_SCHEMA_TERMINAL_OUTCOMES');
			outcomes.clear();
			for (let index = 0; index <= maximum; index++) {
				retain(
					{
						operation: 'drop_schema',
						phase: 'finalize-quiesce',
						schema: `test-${index}`,
						quiesceId: `q-bounded-${index}`,
					},
					{ finalized: true }
				);
			}
			expect(outcomes.size).to.equal(maximum);
			expect(outcomes.has('q-bounded-0')).to.equal(false);
			expect(outcomes.has(`q-bounded-${maximum}`)).to.equal(true);
			outcomes.clear();
		});

		it('does not acknowledge finalization when the strict reset fails', async () => {
			const finishStub = sandbox.stub().returns(true);
			const syncStub = sandbox.stub().rejects(new Error('reset failed'));
			const failStub = sandbox.stub();
			const completeStub = sandbox.stub();
			const restoreFinish = server_itc_handlers.__set__('finishSchemaQuiesce', finishStub);
			const restoreSync = server_itc_handlers.__set__('syncSchemaMetadata', syncStub);
			const restoreFail = server_itc_handlers.__set__('failSchemaQuiesceFinalization', failStub);
			const restoreComplete = server_itc_handlers.__set__('completeSchemaQuiesce', completeStub);
			try {
				const message = {
					originator: 12345,
					operation: 'drop_schema',
					phase: 'finalize-quiesce',
					schema: 'test',
					quiesceId: 'q-reset-failure',
				};
				let failure;
				try {
					await schema_handler({ type: 'schema', message });
				} catch (error) {
					failure = error;
				}
				expect(failure?.message).to.equal('reset failed');
				expect(failStub).to.have.been.calledOnceWithExactly(message);
				expect(completeStub).not.to.have.been.called;
			} finally {
				restoreComplete();
				restoreFail();
				restoreSync();
				restoreFinish();
			}
		});

		it('returns an explicit result after authoritative reconciliation', async () => {
			const finishStub = sandbox.stub().returns(true);
			const syncStub = sandbox.stub().resolves();
			const completeStub = sandbox.stub();
			const restoreFinish = server_itc_handlers.__set__('finishSchemaQuiesce', finishStub);
			const restoreSync = server_itc_handlers.__set__('syncSchemaMetadata', syncStub);
			const restoreComplete = server_itc_handlers.__set__('completeSchemaQuiesce', completeStub);
			try {
				const message = {
					originator: 12345,
					operation: 'drop_table',
					phase: 'reconcile-quiesce',
					schema: 'test',
					table: 'records',
					quiesceId: 'q-reconcile',
				};
				const result = await schema_handler({ type: 'schema', message });
				expect(result).to.deep.equal({ reconciled: true });
				expect(finishStub).to.have.been.calledOnceWithExactly(message);
				expect(syncStub).to.have.been.calledOnceWithExactly(message, true);
				expect(completeStub).to.have.been.calledOnceWithExactly(message);
			} finally {
				restoreComplete();
				restoreSync();
				restoreFinish();
			}
		});

		it('retries a restore close failure and still acknowledges through the schema work', async () => {
			const closeStub = sandbox.stub();
			closeStub.onFirstCall().rejects(new Error('cleanup still active'));
			closeStub.onSecondCall().resolves(true);
			const cleanStub = sandbox.stub().resolves();
			const syncStub = sandbox.stub().resolves();
			const restoreClose = server_itc_handlers.__set__('closeDatabase', closeStub);
			const restoreClean = server_itc_handlers.__set__('cleanLmdbMap', cleanStub);
			const restoreSync = server_itc_handlers.__set__('syncSchemaMetadata', syncStub);
			try {
				await schema_handler({
					type: 'schema',
					message: { originator: 12345, operation: 'restore_backup', schema: 'test' },
				});
				expect(closeStub).to.have.been.calledTwice;
				expect(cleanStub).to.have.been.calledOnce;
				expect(syncStub).to.have.been.calledOnce;
			} finally {
				restoreSync();
				restoreClean();
				restoreClose();
			}
		});

		it('resolves a restore close failure without rescanning an open database', async () => {
			const closeStub = sandbox.stub().rejects(new Error('cleanup still active'));
			const cleanStub = sandbox.stub().resolves();
			const restoreClose = server_itc_handlers.__set__('closeDatabase', closeStub);
			const restoreClean = server_itc_handlers.__set__('cleanLmdbMap', cleanStub);
			try {
				await schema_handler({
					type: 'schema',
					message: { originator: 12345, operation: 'restore_backup', schema: 'test' },
				});
				expect(closeStub).to.have.been.calledTwice;
				expect(cleanStub).not.to.have.been.called;
			} finally {
				restoreClean();
				restoreClose();
			}
		});
	});

	describe('Test componentStatusRequestHandler function', () => {
		let component_status_handler;

		before(() => {
			component_status_handler = server_itc_handlers.__get__('componentStatusRequestHandler');
		});

		// Tests validation: invalid events should be rejected and logged
		it('Test componentStatusRequestHandler logs error on invalid event (missing type)', async () => {
			const test_event = {
				message: { originator: 1, requestId: 'req-123' },
			};
			await component_status_handler(test_event);
			expect(log_error_stub).to.have.been.called;
		});

		// Tests validation: invalid events should be rejected and logged
		it('Test componentStatusRequestHandler logs error on invalid event (missing message)', async () => {
			const test_event = {
				type: 'component_status_request',
			};
			await component_status_handler(test_event);
			expect(log_error_stub).to.have.been.called;
		});

		// Tests validation: invalid events should be rejected and logged
		it('Test componentStatusRequestHandler logs error on invalid event (missing originator)', async () => {
			const test_event = {
				type: 'component_status_request',
				message: { requestId: 'req-123' },
			};
			await component_status_handler(test_event);
			expect(log_error_stub).to.have.been.called;
		});

		// Tests happy path: valid events should be processed without validation errors
		it('Test componentStatusRequestHandler processes valid event without error', async () => {
			sandbox.resetHistory();

			const test_event = {
				type: 'component_status_request',
				message: { originator: 1, requestId: 'req-456' },
			};
			await component_status_handler(test_event);

			// Trace log confirms handler received and started processing the event
			expect(log_trace_stub).to.have.been.called;
		});

		it('Test componentStatusRequestHandler sends response directly when originator is reachable', async () => {
			sandbox.resetHistory();
			const sendToThreadStub = sandbox.stub(global.threads, 'sendToThread').returns(true);

			const test_event = {
				type: 'component_status_request',
				message: { originator: 7, requestId: 'req-789' },
			};
			await component_status_handler(test_event);

			expect(sendToThreadStub).to.have.been.calledOnce;
			expect(sendToThreadStub.firstCall.args[0]).to.equal(7);
			const responseMessage = sendToThreadStub.firstCall.args[1];
			expect(responseMessage.type).to.equal('component_status_response');
			expect(responseMessage.message.requestId).to.equal('req-789');
			// Should have a trace confirming direct send (no error/debug fallback)
			expect(log_error_stub).to.not.have.been.called;
			sendToThreadStub.restore();
		});

		it('Test componentStatusRequestHandler drops response silently when originator is unreachable', async () => {
			sandbox.resetHistory();
			const sendToThreadStub = sandbox.stub(global.threads, 'sendToThread').returns(false);

			const test_event = {
				type: 'component_status_request',
				message: { originator: 42, requestId: 'req-dropped' },
			};
			await component_status_handler(test_event);

			expect(sendToThreadStub).to.have.been.calledOnce;
			// No error, no fallback broadcast — just a trace acknowledging the drop
			expect(log_error_stub).to.not.have.been.called;
			const traceCalls = log_trace_stub.getCalls().map((call) => String(call.args[0]));
			expect(traceCalls.some((msg) => msg.includes('Dropping component status response'))).to.be.true;
			sendToThreadStub.restore();
		});
	});

	describe('Test resourceOpenApiRequestHandler function', () => {
		let resource_openapi_handler;
		let resources_instance;

		before(() => {
			resource_openapi_handler = server_itc_handlers.__get__('resourceOpenApiRequestHandler');
			resources_instance = resetResources();
		});

		afterEach(() => {
			resources_instance.clear();
		});

		// Tests validation: invalid events should be rejected and logged
		it('logs error on invalid event (missing type)', async () => {
			const test_event = {
				message: { originator: 1, requestId: 42, serverHttpURL: 'http://localhost' },
			};
			await resource_openapi_handler(test_event);
			expect(log_error_stub).to.have.been.called;
		});

		// Tests validation: invalid events should be rejected and logged
		it('logs error on invalid event (missing message)', async () => {
			const test_event = {
				type: 'resource_openapi_request',
			};
			await resource_openapi_handler(test_event);
			expect(log_error_stub).to.have.been.called;
		});

		// Tests validation: invalid events should be rejected and logged
		it('logs error on invalid event (missing originator)', async () => {
			const test_event = {
				type: 'resource_openapi_request',
				message: { requestId: 42, serverHttpURL: 'http://localhost' },
			};
			await resource_openapi_handler(test_event);
			expect(log_error_stub).to.have.been.called;
		});

		// Tests guard: a thread with no registered resources must stay silent so that an app
		// worker (which has real resources) responds first and the caller gets the correct spec.
		it('does not respond when this thread has no registered resources', async () => {
			sandbox.resetHistory();
			const sendToThreadStub = sandbox.stub(global.threads, 'sendToThread').returns(true);

			const test_event = {
				type: 'resource_openapi_request',
				message: { originator: 5, requestId: 99, serverHttpURL: 'http://localhost:9925' },
			};
			await resource_openapi_handler(test_event);

			expect(sendToThreadStub).to.not.have.been.called;
			expect(log_error_stub).to.not.have.been.called;
			sendToThreadStub.restore();
		});

		it('sends OpenAPI response directly when originator is reachable', async () => {
			sandbox.resetHistory();
			// Resources.set wraps the argument as entry.Resource; passing {isError:true} makes
			// generateJsonApi skip the entry so the spec is minimal but the send path is exercised.
			resources_instance.set('test', { isError: true });
			const sendToThreadStub = sandbox.stub(global.threads, 'sendToThread').returns(true);

			const test_event = {
				type: 'resource_openapi_request',
				message: { originator: 5, requestId: 99, serverHttpURL: 'http://localhost:9925' },
			};
			await resource_openapi_handler(test_event);

			expect(sendToThreadStub).to.have.been.calledOnce;
			expect(sendToThreadStub.firstCall.args[0]).to.equal(5);
			const responseMessage = sendToThreadStub.firstCall.args[1];
			expect(responseMessage.type).to.equal('resource_openapi_response');
			expect(responseMessage.message.requestId).to.equal(99);
			expect(responseMessage.message.openapi).to.be.an('object');
			expect(log_error_stub).to.not.have.been.called;
			sendToThreadStub.restore();
		});

		it('drops response silently when originator is unreachable', async () => {
			sandbox.resetHistory();
			resources_instance.set('test', { isError: true });
			const sendToThreadStub = sandbox.stub(global.threads, 'sendToThread').returns(false);

			const test_event = {
				type: 'resource_openapi_request',
				message: { originator: 99, requestId: 7, serverHttpURL: 'http://localhost:9925' },
			};
			await resource_openapi_handler(test_event);

			expect(sendToThreadStub).to.have.been.calledOnce;
			expect(log_error_stub).to.not.have.been.called;
			const traceCalls = log_trace_stub.getCalls().map((call) => String(call.args[0]));
			expect(traceCalls.some((msg) => msg.includes('Dropping resource OpenAPI response'))).to.be.true;
			sendToThreadStub.restore();
		});
	});

	describe('Test resource-registration handler function (#1448)', () => {
		const resource_handler = server_itc_handlers.resourceHandler;

		// Listeners live on a module-global array; clear between cases so fakes don't leak forward.
		afterEach(() => resource_handler._resetListenersForTest());

		it('invokes every registered listener when fired', () => {
			const a = sinon.fake();
			const b = sinon.fake();
			resource_handler.addListener(a);
			resource_handler.addListener(b);
			resource_handler();
			expect(a).to.have.been.calledOnce;
			expect(b).to.have.been.calledOnce;
		});

		it('isolates a throwing listener so siblings still run, and logs the error', () => {
			sandbox.resetHistory();
			const boom = sinon.fake.throws(new Error(TEST_ERR));
			const after = sinon.fake();
			resource_handler.addListener(boom);
			resource_handler.addListener(after);
			expect(() => resource_handler()).to.not.throw();
			expect(after).to.have.been.calledOnce;
			expect(log_error_stub).to.have.been.called;
		});
	});
});
