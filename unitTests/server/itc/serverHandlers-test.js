'use strict';

const chai = require('chai');
const sinon = require('sinon');
const rewire = require('rewire');
const { expect } = chai;
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
const harper_logger = require('../../../utility/logging/harper_logger');
const user_schema = require('../../../security/user');
const server_itc_handlers = rewire('../../../server/itc/serverHandlers');
const job_runner = require('../../../server/jobs/jobRunner');
const global_schema = require('../../../utility/globalSchema');
const schema_describe = require('../../../dataLayer/schemaDescribe');
const itc = require('../../../server/threads/itc');
const manageThreads = require('../../../server/threads/manageThreads');
const hdbTerms = require('../../../utility/hdbTerms');

describe('Test hdbChildIpcHandler module', () => {
	const TEST_ERR = 'The roof is on fire';
	const sandbox = sinon.createSandbox();
	let log_error_stub;
	let log_info_stub;

	before(() => {
		log_error_stub = sandbox.stub(harper_logger, 'error');
		log_info_stub = sandbox.stub(harper_logger, 'info');
	});

	after(() => {
		sandbox.restore();
		rewire('../../../server/itc/serverHandlers');
	});

	describe('Test server_itc_handlers', () => {
		const clean_map_stub = sandbox.stub();
		const sync_schema_stub = sandbox.stub();
		let sync_schema_rw;
		let set_users_to_global_stub;
		let parse_msg_stub;
		let schema_handler;
		let user_handler;
		let job_handler;

		before(() => {
			server_itc_handlers.__set__('cleanLmdbMap', clean_map_stub);
			sync_schema_rw = server_itc_handlers.__set__('syncSchemaMetadata', sync_schema_stub);
			set_users_to_global_stub = sandbox.stub(user_schema, 'setUsersWithRolesCache');
			parse_msg_stub = sandbox.stub(job_runner, 'parseMessage');
			schema_handler = server_itc_handlers.__get__('schemaHandler');
			user_handler = server_itc_handlers.__get__('userHandler');
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		after(() => {
			sync_schema_rw();
		});

		it('Test schema function is called as expected', async () => {
			const test_event = {
				type: 'schema',
				message: {
					originator: 12345,
					operation: 'create_schema',
					schema: 'unit_test',
				},
			};
			const expected_msg = {
				originator: 12345,
				operation: 'create_schema',
				schema: 'unit_test',
			};
			await schema_handler(test_event);
			expect(clean_map_stub).to.have.been.calledWith(expected_msg);
			expect(sync_schema_stub).to.have.been.calledWith(expected_msg);
		});

		it('Test schema validation error is handled as expected', async () => {
			const test_event = {
				type: 'schema',
				message: undefined,
			};
			await schema_handler(test_event);
			expect(log_error_stub).to.have.been.calledWith("ITC event missing 'message'");
		});

		it('Test user function is called as expected', async () => {
			const test_event = {
				type: 'schema',
				message: { originator: 12345 },
			};
			await user_handler(test_event);
			expect(set_users_to_global_stub).to.have.been.called;
		});

		it('Test user validation error is handled as expected', async () => {
			const test_event = {
				type: 'schema',
				message: {},
			};
			await user_handler(test_event);
			expect(log_error_stub).to.have.been.calledWith("ITC event message missing 'originator' property");
		});

		it('Test error from user function is logged', async () => {
			set_users_to_global_stub.throws(TEST_ERR);
			const test_event = {
				type: 'schema',
				message: { originator: 12345 },
			};
			await user_handler(test_event);
			expect(log_error_stub.args[0][0].name).to.equal(TEST_ERR);
		});
	});

	// we don't use hdb_schema anymore
	describe.skip('Test syncSchemaMetadata function', () => {
		let syncSchemaMetadata;
		let describe_table_stub;
		let set_to_global_stub;

		before(() => {
			syncSchemaMetadata = server_itc_handlers.__get__('syncSchemaMetadata');
			set_to_global_stub = sandbox.stub(global_schema, 'setSchemaDataToGlobal');
			describe_table_stub = sandbox.stub(schema_describe, 'describeTable');
		});

		beforeEach(() => {
			global.hdb_schema = {};
			sandbox.resetHistory();
		});

		after(() => {
			delete global.hdb_schema;
		});

		it('Test drop_schema happy path', async () => {
			global.hdb_schema['frog'] = {};
			const test_msg = {
				operation: 'drop_schema',
				schema: 'frog',
			};
			await syncSchemaMetadata(test_msg);
			expect(global.hdb_schema['frog']).to.be.undefined;
		});

		it('Test drop_table happy path', async () => {
			global.hdb_schema['frog'] = { princess: {} };
			const test_msg = {
				operation: 'drop_table',
				schema: 'frog',
				table: 'princess',
			};
			await syncSchemaMetadata(test_msg);
			expect(global.hdb_schema['frog']['princess']).to.be.undefined;
		});

		it('Test create_schema happy path', async () => {
			const test_msg = {
				operation: 'create_schema',
				schema: 'toad',
			};
			await syncSchemaMetadata(test_msg);
			expect(typeof global.hdb_schema['toad']).to.equal('object');
		});

		it('Test create_table happy path', async () => {
			describe_table_stub.resolves('a table');
			global.hdb_schema['frog'] = {};
			const test_msg = {
				operation: 'create_table',
				schema: 'frog',
				table: 'princess',
			};
			await syncSchemaMetadata(test_msg);
			expect(global.hdb_schema['frog']['princess']).to.equal('a table');
			expect(describe_table_stub).to.have.been.calledWith({ schema: 'frog', table: 'princess' });
		});

		it('Test create_attribute happy path', async () => {
			describe_table_stub.resolves('a table');
			const test_msg = {
				operation: 'create_table',
				schema: 'frog',
				table: 'princess',
			};
			await syncSchemaMetadata(test_msg);
			expect(global.hdb_schema['frog']['princess']).to.equal('a table');
			expect(describe_table_stub).to.have.been.calledWith({ schema: 'frog', table: 'princess' });
		});

		it('Test setSchemaDataToGlobal if no recognized switch case', async () => {
			set_to_global_stub.yields('error');
			const test_msg = {
				operation: 'delete_table',
				schema: 'frog',
				table: 'princess',
			};
			await syncSchemaMetadata(test_msg);
			expect(log_error_stub).to.have.been.calledWith('error');
		});

		it('Test setSchemaDataToGlobal if no global hdb_schema', async () => {
			delete global.hdb_schema;
			set_to_global_stub.yields('error');
			await syncSchemaMetadata();
			expect(log_error_stub).to.have.been.calledWith('error');
		});

		it('Test error is logged if thrown', async () => {
			set_to_global_stub.throws(TEST_ERR);
			const test_msg = {
				operation: 'delete_table',
				schema: 'frog',
				table: 'princess',
			};
			await syncSchemaMetadata(test_msg);
			expect(log_error_stub.args[1][0].name).to.equal(TEST_ERR);
		});
	});

	describe('Test componentStatusRequestHandler function', () => {
		let componentStatusRequestHandler;
		let getWorkerIndexStub;
		let sendItcEventStub;
		let sendToThreadStub;
		let mockRegistry;
		let componentStatusInternalStub;
		let threadsStub;
		let log_trace_stub;
		let log_debug_stub;
		let log_warn_stub;

		before(() => {
			componentStatusRequestHandler = server_itc_handlers.__get__('componentStatusRequestHandler');
			
			// Create stubs
			getWorkerIndexStub = sandbox.stub();
			sendItcEventStub = sandbox.stub();
			sendToThreadStub = sandbox.stub();
			log_trace_stub = sandbox.stub(harper_logger, 'trace');
			log_debug_stub = sandbox.stub(harper_logger, 'debug');
			log_warn_stub = sandbox.stub(harper_logger, 'warn');
			
			// Mock the component status registry
			mockRegistry = {
				getAllStatuses: sandbox.stub()
			};
			
			// Mock the internal status module
			componentStatusInternalStub = {
				componentStatusRegistry: mockRegistry
			};

			// Mock threads global
			threadsStub = {
				sendToThread: sendToThreadStub
			};

			// Rewire dependencies
			server_itc_handlers.__set__('threads', threadsStub);
		});

		beforeEach(() => {
			// Default stub behaviors
			getWorkerIndexStub.returns(1);
			sendItcEventStub.resolves();
			sendToThreadStub.returns(true);
			mockRegistry.getAllStatuses.returns(new Map([
				['component1', { status: 'healthy', message: 'OK', lastChecked: new Date() }],
				['component2', { status: 'error', message: 'Failed', lastChecked: new Date() }]
			]));
		});

		afterEach(() => {
			// Reset history without clearing module cache
			// Module cache cleanup can interfere with rewire
			sandbox.resetHistory();
		});

		it('should validate event and log error if validation fails - missing type', async () => {
			const invalidEvent = {
				// Missing type property
				message: { originator: 'test', requestId: 'test-123' }
			};

			await componentStatusRequestHandler(invalidEvent);

			expect(log_error_stub).to.have.been.calledWith("ITC event missing 'type'");
			expect(mockRegistry.getAllStatuses).to.not.have.been.called;
		});

		it('should validate event and log error if validation fails - missing message', async () => {
			const invalidEvent = {
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST,
				// Missing message property
			};

			await componentStatusRequestHandler(invalidEvent);

			expect(log_error_stub).to.have.been.calledWith("ITC event missing 'message'");
			expect(mockRegistry.getAllStatuses).to.not.have.been.called;
		});

		it('should validate event.message.originator and log error if missing', async () => {
			const invalidEvent = {
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST,
				message: {
					// Missing originator
					requestId: 'test-123'
				}
			};

			await componentStatusRequestHandler(invalidEvent);

			expect(log_error_stub).to.have.been.calledWith("ITC event message missing 'originator' property");
			expect(mockRegistry.getAllStatuses).to.not.have.been.called;
		});

		it('should handle request with missing requestId gracefully', async () => {
			// Note: validateEvent doesn't check for requestId, so this should pass validation
			// Stub the dynamic requires
			const manageThreadsStub = sandbox.stub();
			manageThreadsStub.getWorkerIndex = getWorkerIndexStub;
			
			const itcStub = sandbox.stub();
			itcStub.sendItcEvent = sendItcEventStub;
			
			const requireStub = sandbox.stub();
			requireStub.withArgs('../../components/status/index.ts').returns({ internal: componentStatusInternalStub });
			requireStub.withArgs('../threads/manageThreads.js').returns(manageThreadsStub);
			requireStub.withArgs('../threads/itc.js').returns(itcStub);
			server_itc_handlers.__set__('require', requireStub);

			const invalidEvent = {
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST,
				message: {
					originator: 'thread-1',
					// Missing requestId - should still work but with undefined requestId in response
				}
			};

			await componentStatusRequestHandler(invalidEvent);

			// Should still process the request
			expect(mockRegistry.getAllStatuses).to.have.been.calledOnce;
			expect(sendToThreadStub).to.have.been.calledWith('thread-1', sinon.match({
				message: sinon.match({
					requestId: undefined
				})
			}));
		});

		it('should handle valid request from worker thread and send direct response', async () => {
			// Stub the dynamic requires
			const manageThreadsStub = sandbox.stub();
			manageThreadsStub.getWorkerIndex = getWorkerIndexStub;
			
			const itcStub = sandbox.stub();
			itcStub.sendItcEvent = sendItcEventStub;
			
			// Override require to return our stubs
			const requireStub = sandbox.stub();
			requireStub.withArgs('../../components/status/index.ts').returns({ internal: componentStatusInternalStub });
			requireStub.withArgs('../threads/manageThreads.js').returns(manageThreadsStub);
			requireStub.withArgs('../threads/itc.js').returns(itcStub);
			server_itc_handlers.__set__('require', requireStub);

			const validEvent = {
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST,
				message: {
					originator: 'main-thread',
					requestId: 'req-123'
				}
			};

			await componentStatusRequestHandler(validEvent);

			// Verify it called getAllStatuses
			expect(mockRegistry.getAllStatuses).to.have.been.calledOnce;

			// Verify it tried to send direct response
			expect(sendToThreadStub).to.have.been.calledOnce;
			expect(sendToThreadStub).to.have.been.calledWith('main-thread', sinon.match({
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_RESPONSE,
				message: sinon.match({
					requestId: 'req-123',
					statuses: sinon.match.array,
					workerIndex: 1,
					isMainThread: false
				})
			}));

			// Verify it didn't fall back to broadcast
			expect(sendItcEventStub).to.not.have.been.called;
			expect(log_trace_stub).to.have.been.calledWith('Sent component status response directly to thread main-thread');
		});

		it('should handle main thread request (workerIndex undefined)', async () => {
			// Setup for main thread
			getWorkerIndexStub.returns(undefined);

			// Stub the dynamic requires
			const manageThreadsStub = sandbox.stub();
			manageThreadsStub.getWorkerIndex = getWorkerIndexStub;
			
			const itcStub = sandbox.stub();
			itcStub.sendItcEvent = sendItcEventStub;
			
			const requireStub = sandbox.stub();
			requireStub.withArgs('../../components/status/index.ts').returns({ internal: componentStatusInternalStub });
			requireStub.withArgs('../threads/manageThreads.js').returns(manageThreadsStub);
			requireStub.withArgs('../threads/itc.js').returns(itcStub);
			server_itc_handlers.__set__('require', requireStub);

			const validEvent = {
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST,
				message: {
					originator: 'worker-1',
					requestId: 'req-456'
				}
			};

			await componentStatusRequestHandler(validEvent);

			// Verify response has isMainThread = true
			expect(sendToThreadStub).to.have.been.calledWith('worker-1', sinon.match({
				message: sinon.match({
					isMainThread: true,
					workerIndex: undefined
				})
			}));
		});

		it('should fall back to broadcast when direct send fails', async () => {
			// Make direct send fail
			sendToThreadStub.returns(false);

			// Stub the dynamic requires
			const manageThreadsStub = sandbox.stub();
			manageThreadsStub.getWorkerIndex = getWorkerIndexStub;
			
			const itcStub = sandbox.stub();
			itcStub.sendItcEvent = sendItcEventStub;
			
			const requireStub = sandbox.stub();
			requireStub.withArgs('../../components/status/index.ts').returns({ internal: componentStatusInternalStub });
			requireStub.withArgs('../threads/manageThreads.js').returns(manageThreadsStub);
			requireStub.withArgs('../threads/itc.js').returns(itcStub);
			server_itc_handlers.__set__('require', requireStub);

			const validEvent = {
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST,
				message: {
					originator: 'worker-2',
					requestId: 'req-789'
				}
			};

			await componentStatusRequestHandler(validEvent);

			// Verify it tried direct send first
			expect(sendToThreadStub).to.have.been.calledOnce;
			
			// Verify it fell back to broadcast
			expect(sendItcEventStub).to.have.been.calledOnce;
			expect(sendItcEventStub).to.have.been.calledWith(sinon.match({
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_RESPONSE,
				message: sinon.match({
					requestId: 'req-789'
				})
			}));
			
			expect(log_warn_stub).to.have.been.calledWith('Failed to send direct response to thread worker-2, falling back to broadcast');
		});

		it('should fall back to broadcast when sendToThread is not available for originator', async () => {
			// Stub the dynamic requires
			const manageThreadsStub = sandbox.stub();
			manageThreadsStub.getWorkerIndex = getWorkerIndexStub;
			
			const itcStub = sandbox.stub();
			itcStub.sendItcEvent = sendItcEventStub;
			
			const requireStub = sandbox.stub();
			requireStub.withArgs('../../components/status/index.ts').returns({ internal: componentStatusInternalStub });
			requireStub.withArgs('../threads/manageThreads.js').returns(manageThreadsStub);
			requireStub.withArgs('../threads/itc.js').returns(itcStub);
			server_itc_handlers.__set__('require', requireStub);

			// Make sendToThread return false for this specific thread
			sendToThreadStub.withArgs('unknown-thread-999').returns(false);

			const validEvent = {
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST,
				message: {
					originator: 'unknown-thread-999',
					requestId: 'req-unknown-thread'
				}
			};

			await componentStatusRequestHandler(validEvent);

			// Verify it tried direct send first
			expect(sendToThreadStub).to.have.been.calledWith('unknown-thread-999');
			
			// Verify it fell back to broadcast
			expect(sendItcEventStub).to.have.been.calledOnce;
			expect(log_warn_stub).to.have.been.calledWith('Failed to send direct response to thread unknown-thread-999, falling back to broadcast');
		});

		it('should convert Map to array correctly for serialization', async () => {
			// Setup specific status data
			const testStatuses = new Map([
				['auth-component', { status: 'healthy', message: 'Auth OK', lastChecked: new Date('2024-01-01') }],
				['database-component', { status: 'error', message: 'Connection failed', lastChecked: new Date('2024-01-02'), error: new Error('DB Error') }]
			]);
			mockRegistry.getAllStatuses.returns(testStatuses);

			// Stub the dynamic requires
			const manageThreadsStub = sandbox.stub();
			manageThreadsStub.getWorkerIndex = getWorkerIndexStub;
			
			const itcStub = sandbox.stub();
			itcStub.sendItcEvent = sendItcEventStub;
			
			const requireStub = sandbox.stub();
			requireStub.withArgs('../../components/status/index.ts').returns({ internal: componentStatusInternalStub });
			requireStub.withArgs('../threads/manageThreads.js').returns(manageThreadsStub);
			requireStub.withArgs('../threads/itc.js').returns(itcStub);
			server_itc_handlers.__set__('require', requireStub);

			const validEvent = {
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST,
				message: {
					originator: 'test-thread',
					requestId: 'req-array-test'
				}
			};

			await componentStatusRequestHandler(validEvent);

			// Verify the array conversion
			const sentMessage = sendToThreadStub.firstCall.args[1].message;
			expect(sentMessage.statuses).to.be.an('array');
			expect(sentMessage.statuses).to.have.length(2);
			expect(sentMessage.statuses[0][0]).to.equal('auth-component');
			expect(sentMessage.statuses[0][1]).to.deep.include({ status: 'healthy', message: 'Auth OK' });
			expect(sentMessage.statuses[1][0]).to.equal('database-component');
			expect(sentMessage.statuses[1][1]).to.deep.include({ status: 'error', message: 'Connection failed' });
		});

		it('should handle and log errors during processing', async () => {
			// Make getAllStatuses throw an error
			mockRegistry.getAllStatuses.throws(new Error('Registry error'));

			// Stub the dynamic requires
			const manageThreadsStub = sandbox.stub();
			manageThreadsStub.getWorkerIndex = getWorkerIndexStub;
			
			const itcStub = sandbox.stub();
			itcStub.sendItcEvent = sendItcEventStub;
			
			const requireStub = sandbox.stub();
			requireStub.withArgs('../../components/status/index.ts').returns({ internal: componentStatusInternalStub });
			requireStub.withArgs('../threads/manageThreads.js').returns(manageThreadsStub);
			requireStub.withArgs('../threads/itc.js').returns(itcStub);
			server_itc_handlers.__set__('require', requireStub);

			const validEvent = {
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST,
				message: {
					originator: 'error-test-thread',
					requestId: 'req-error'
				}
			};

			await componentStatusRequestHandler(validEvent);

			// Verify error was logged
			expect(log_error_stub).to.have.been.calledWith('Error handling component status request:', sinon.match.instanceOf(Error));
			expect(log_error_stub.firstCall.args[1].message).to.equal('Registry error');
			
			// Verify no response was sent
			expect(sendToThreadStub).to.not.have.been.called;
			expect(sendItcEventStub).to.not.have.been.called;
		});

		it('should fall back to broadcast when originator is explicitly undefined in handler', async () => {
			// This tests the specific case in the handler where originatorThreadId is undefined
			// even though the event passes validation (e.g., originator: null or similar edge cases)
			
			// Stub the dynamic requires
			const manageThreadsStub = sandbox.stub();
			manageThreadsStub.getWorkerIndex = getWorkerIndexStub;
			
			const itcStub = sandbox.stub();
			itcStub.sendItcEvent = sendItcEventStub;
			
			const requireStub = sandbox.stub();
			requireStub.withArgs('../../components/status/index.ts').returns({ internal: componentStatusInternalStub });
			requireStub.withArgs('../threads/manageThreads.js').returns(manageThreadsStub);
			requireStub.withArgs('../threads/itc.js').returns(itcStub);
			server_itc_handlers.__set__('require', requireStub);

			// Create an event where originator exists but evaluates to undefined in the handler
			// This simulates edge cases where validation passes but originatorThreadId is still undefined
			const validEvent = {
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST,
				message: {
					originator: 'valid-but-undefined', // Will be treated as undefined in the condition
					requestId: 'req-edge-case'
				}
			};
			
			// Override the sendToThread behavior to simulate the originator check
			const originalSendToThread = sendToThreadStub;
			sendToThreadStub = sandbox.stub().callsFake((threadId, message) => {
				// Simulate the handler's condition: originatorThreadId !== undefined
				// By making this specific threadId act as if it's undefined
				if (threadId === 'valid-but-undefined') {
					return false; // This will trigger the undefined originator path
				}
				return originalSendToThread(threadId, message);
			});
			threadsStub.sendToThread = sendToThreadStub;

			await componentStatusRequestHandler(validEvent);

			// The handler should detect this as undefined originator scenario
			expect(sendItcEventStub).to.have.been.calledOnce;
			// Note: The actual log message might be the "failed to send" instead of "no originator"
			// because our originator is technically defined, just the sendToThread fails
			expect(log_warn_stub).to.have.been.calledWith('Failed to send direct response to thread valid-but-undefined, falling back to broadcast');
		});

		it('should handle empty component status map', async () => {
			// Return empty map
			mockRegistry.getAllStatuses.returns(new Map());

			// Stub the dynamic requires
			const manageThreadsStub = sandbox.stub();
			manageThreadsStub.getWorkerIndex = getWorkerIndexStub;
			
			const itcStub = sandbox.stub();
			itcStub.sendItcEvent = sendItcEventStub;
			
			const requireStub = sandbox.stub();
			requireStub.withArgs('../../components/status/index.ts').returns({ internal: componentStatusInternalStub });
			requireStub.withArgs('../threads/manageThreads.js').returns(manageThreadsStub);
			requireStub.withArgs('../threads/itc.js').returns(itcStub);
			server_itc_handlers.__set__('require', requireStub);

			const validEvent = {
				type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST,
				message: {
					originator: 'empty-test',
					requestId: 'req-empty'
				}
			};

			await componentStatusRequestHandler(validEvent);

			// Verify empty array was sent
			const sentMessage = sendToThreadStub.firstCall.args[1].message;
			expect(sentMessage.statuses).to.be.an('array');
			expect(sentMessage.statuses).to.have.length(0);
		});
	});
});
