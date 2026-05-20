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

		before(() => {
			resource_openapi_handler = server_itc_handlers.__get__('resourceOpenApiRequestHandler');
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

		it('sends OpenAPI response directly when originator is reachable', async () => {
			sandbox.resetHistory();
			const sendToThreadStub = sandbox.stub(global.threads, 'sendToThread').returns(true);
			// Inject a minimal mock for generateJsonApi and a non-empty resources Map
			const mockOpenapi = { openapi: '3.0.3', paths: {} };
			const mockResources = new Map([['test', { path: 'test', Resource: { isError: false } }]]);
			server_itc_handlers.__set__('require', (path) => {
				if (path.includes('Resources')) return { resources: mockResources };
				if (path.includes('openApi')) return { generateJsonApi: () => mockOpenapi };
				return require(path);
			});

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
			expect(responseMessage.message.openapi).to.deep.equal(mockOpenapi);
			expect(log_error_stub).to.not.have.been.called;
			sendToThreadStub.restore();
			// Restore original require
			server_itc_handlers.__set__('require', require);
		});

		it('drops response silently when originator is unreachable', async () => {
			sandbox.resetHistory();
			const sendToThreadStub = sandbox.stub(global.threads, 'sendToThread').returns(false);
			const mockResources = new Map([['test', { path: 'test', Resource: { isError: false } }]]);
			server_itc_handlers.__set__('require', (path) => {
				if (path.includes('Resources')) return { resources: mockResources };
				if (path.includes('openApi')) return { generateJsonApi: () => ({}) };
				return require(path);
			});

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
			server_itc_handlers.__set__('require', require);
		});
	});
});
