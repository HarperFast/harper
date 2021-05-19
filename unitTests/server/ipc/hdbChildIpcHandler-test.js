'use strict';

const chai = require('chai');
const sinon = require('sinon');
const rewire = require('rewire');
const { expect } = chai;
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
const test_util = require('../../test_utils');
const harper_logger = require('../../../utility/logging/harper_logger');
const user_schema = require('../../../security/user');
const hdb_child_ipc_handlers = rewire('../../../server/ipc/hdbChildIpcHandlers');
const job_runner = require('../../../server/jobRunner');

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
        rewire('../../../server/ipc/hdbChildIpcHandlers');
    });

    describe('Test hdb_child_ipc_handlers', () => {
        const clean_map_stub = sandbox.stub();
        const sync_schema_stub = sandbox.stub();
        let set_users_to_global_stub;
        let parse_msg_stub;

        before(() => {
            hdb_child_ipc_handlers.__set__('clean_lmdb_map', clean_map_stub);
            hdb_child_ipc_handlers.__set__('syncSchemaMetadata', sync_schema_stub);
            set_users_to_global_stub = sandbox.stub(user_schema, 'setUsersToGlobal');
            parse_msg_stub = sandbox.stub(job_runner, 'parseMessage');
        });

        afterEach(() => {
            sandbox.resetHistory();
        });

        it('Test schema function is called as expected', async () => {
            const test_event = {
                "type": "schema",
                "message": {
                    "operation": "create_schema",
                    "schema": "unit_test"
                }
            };
            const expected_msg = {
                "operation": "create_schema",
                "schema": "unit_test"
            };
            await hdb_child_ipc_handlers.schema(test_event);
            expect(clean_map_stub).to.have.been.calledWith(expected_msg);
            expect(sync_schema_stub).to.have.been.calledWith(expected_msg);
        });

        it('Test schema validation error is handled as expected', async () => {
            const test_event = {
                "type": "schema",
                "message": undefined
            };
            await hdb_child_ipc_handlers.schema(test_event);
            expect(log_error_stub).to.have.been.calledWith("IPC event missing 'message'");
        });

        it('Test user function is called as expected', async () => {
            await hdb_child_ipc_handlers.user();
            expect(set_users_to_global_stub).to.have.been.called;
        });

        it('Test error from user function is logged', async () => {
            set_users_to_global_stub.throws(TEST_ERR);
            await hdb_child_ipc_handlers.user();
            expect(log_error_stub.args[0][0].name).to.equal(TEST_ERR);
        });

        it('Test job function is called as expected', async () => {
            const test_event = {
                "type": "job",
                "message": {
                    "job": {
                        "operation":"csv_file_load",
                        "action":"insert",
                        "schema":"unit_test",
                        "table":"daugz",
                        "file_path":"daugz.csv"
                    },
                    "json": {
                        "message": "job started"
                    }
                }
            };
            const expected_message = {
                "job": {
                    "operation":"csv_file_load",
                    "action":"insert",
                    "schema":"unit_test",
                    "table":"daugz",
                    "file_path":"daugz.csv"
                },
                "json": {
                    "message": "job started"
                }
            };

            await hdb_child_ipc_handlers.job(test_event);
            expect(parse_msg_stub).to.have.been.calledWith(expected_message);
        });

        it('Test error from job function is logged', async () => {
            const test_event = {
                "type": "job",
                "message": 'hi'
            };
            parse_msg_stub.throws(TEST_ERR);
            await hdb_child_ipc_handlers.job(test_event);
            expect(log_error_stub.args[0][0].name).to.equal(TEST_ERR);
        });

        it('Test job validation error is handled as expected', async () => {
            const test_event = {
                "type": "job"
            };
            await hdb_child_ipc_handlers.job(test_event);
            expect(log_error_stub).to.have.been.calledWith("IPC event missing 'message'");
        });
    });
});