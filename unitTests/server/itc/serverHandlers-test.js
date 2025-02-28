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
			server_itc_handlers.__set__('clean_lmdb_map', clean_map_stub);
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
});
