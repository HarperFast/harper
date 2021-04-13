'use strict';

const rewire = require('rewire');
const path = require('path');
const chai = require('chai');
const fs = require('fs-extra');
const { expect } = chai;
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
const test_utils = require('../../../test_utils');
const logger = require('../../../../utility/logging/harper_logger');
const env_mngr = require('../../../../utility/environment/environmentManager');
const lmdb_common = require('../../../../utility/lmdb/commonUtility');

const TEST_DIR = 'reindexTestDir';
const BASE_PATH_TEST = path.join(__dirname, TEST_DIR);
const SCHEMA_PATH_TEST = path.join(BASE_PATH_TEST, 'schema');
const TMP_PATH_TEST = path.join(BASE_PATH_TEST, '3_0_0_upgrade_tmp');
const TRANSACTIONS_PATH_TEST = path.join(BASE_PATH_TEST, 'transactions');
const OLD_ENV_SCHEMA = path.join(BASE_PATH_TEST, 'oldNodeLmdbEnv', 'schema');
const OLD_ENV_TRANSACTIONS = path.join(BASE_PATH_TEST, 'oldNodeLmdbEnv', 'transactions');

describe('Test reindex module', () => {
    const sandbox = sinon.createSandbox();
    const the_schema_path_dev_test = path.join(SCHEMA_PATH_TEST, 'dev');
    const the_tran_schema_path_dev_test = path.join(TRANSACTIONS_PATH_TEST, 'dev');
    const tmp_schema_path_test = path.join(TMP_PATH_TEST, 'dev');
    const pino_info_fake = sinon.fake();
    const pino_error_fake = sinon.fake();
    const pino_logger_test = {
        info: pino_info_fake,
        error: pino_error_fake
    };
    let reindex_rw;
    let logger_notify_stub;
    let logger_error_stub;

    before(() => {
        // This stub and rewire need to be here as putting it in outer scope was messing interfering with other tests.
        sandbox.stub(env_mngr,'getHdbBasePath').returns(BASE_PATH_TEST);
        reindex_rw = rewire('../../../../upgrade/directives/upgrade_scripts/3_0_0_reindex_script');
        logger_notify_stub = sandbox.stub(logger, 'notify');
        logger_error_stub = sandbox.stub(logger, 'error');
        reindex_rw.__set__('pino_logger', pino_logger_test);
        sandbox.stub(console, 'error');
        sandbox.stub(console, 'info');
    });

    afterEach(() => {
        sandbox.resetHistory();
        pino_info_fake.resetHistory();
        pino_error_fake.resetHistory();
    });

    after(async () => {
        sandbox.restore();
        rewire('../../../../upgrade/directives/upgrade_scripts/3_0_0_reindex_script');
        await fs.remove(TMP_PATH_TEST);
    });

    describe('Test reindexUpgrade function', () => {
        const get_schema_tables_stub = sandbox.stub();
        let get_schema_tables_rw;

        before(() => {
            get_schema_tables_rw = reindex_rw.__set__('getSchemaTable', get_schema_tables_stub);
        });

        after(() => {
            get_schema_tables_rw();
        });

        it('Test logs and functions are called as expected happy path', async () => {
            await reindex_rw();

            expect(logger_notify_stub.getCall(0)).to.have.been.calledWith('Reindexing upgrade started for schemas');
            expect(logger_notify_stub.getCall(1)).to.have.been.calledWith('Reindexing upgrade started for transaction logs');
            expect(logger_notify_stub.getCall(2)).to.have.been.calledWith('Reindexing upgrade complete');
            expect(get_schema_tables_stub.getCall(0)).to.have.been.calledWith(SCHEMA_PATH_TEST);
            expect(get_schema_tables_stub.getCall(1)).to.have.been.calledWith(TRANSACTIONS_PATH_TEST);
        });
    });

    describe('Test getSchemaTable function', () => {
        const process_table_stub = sandbox.stub();
        const init_pino_logger_stub = sandbox.stub();
        let getSchemaTables;
        let process_table_rw;
        let init_pino_logger_rw;
        let fs_remove_spy;
        let fs_empty_dir_stub;

        before(() => {
            fs_remove_spy = sandbox.spy(fs, 'remove');
            fs_empty_dir_stub = sandbox.stub(fs, 'emptyDir');
            getSchemaTables = reindex_rw.__get__('getSchemaTable');
            process_table_rw = reindex_rw.__set__('processTable', process_table_stub);
            init_pino_logger_rw = reindex_rw.__set__('initPinoLogger', init_pino_logger_stub);
        });

        after(() => {
            process_table_rw();
            init_pino_logger_rw();
            fs_empty_dir_stub.restore();
        });

        it('Test schema and tables are loaded happy path', async () => {
            await getSchemaTables(SCHEMA_PATH_TEST, false);

            expect(init_pino_logger_stub.getCall(0)).to.have.been.calledWith('dev', 'dog', false);
            expect(init_pino_logger_stub.getCall(1)).to.have.been.calledWith('dev', 'owner', false);
            expect(process_table_stub.getCall(0)).to.have.been.calledWith('dev', 'dog', the_schema_path_dev_test, false);
            expect(process_table_stub.getCall(1)).to.have.been.calledWith('dev', 'owner', the_schema_path_dev_test, false);
            expect(fs_remove_spy).to.have.been.calledWith(TMP_PATH_TEST);
            expect(fs_empty_dir_stub).to.have.been.calledWith(tmp_schema_path_test);
        });

        it('Test error is handled as expected', async () => {
            process_table_stub.throws(new Error('Error processing table'));
            await getSchemaTables(SCHEMA_PATH_TEST, false);

            expect(logger_error_stub.getCall(0)).to.have.been.calledWith('There was an error with the reindex upgrade, check the logs in hdb/3_0_0_upgrade_tmp for more details');
            expect(logger_error_stub.getCall(1).args[0].message).to.equal('Error processing table');
            expect(logger_error_stub.getCall(1).args[0].schema_path).to.equal(the_schema_path_dev_test);
            expect(logger_error_stub.getCall(1).args[0].table_name).to.equal('owner');
            expect(fs_remove_spy).to.have.not.been.called;
            expect(fs_empty_dir_stub).to.have.been.calledWith(tmp_schema_path_test);
        });
    });

    describe('Test initPinoLogger', () => {
        const pino_stub = sandbox.stub();
        let initPinoLogger;
        let ensure_dir_stub;
        let write_file_stub;

        before(() => {
            initPinoLogger = reindex_rw.__get__('initPinoLogger');
            ensure_dir_stub = sandbox.stub(fs, 'ensureDir');
            write_file_stub = sandbox.stub(fs, 'writeFile');
            reindex_rw.__set__('pino', pino_stub);
        });

        after(() => {
            reindex_rw.__set__('pino_logger', pino_logger_test);
        });

        it('Test fs and pino stubs are called as expected happy path', async () => {
            const expected_log_dest = path.join(TMP_PATH_TEST, 'dev_dog_transaction_reindex.log');
            await initPinoLogger('dev', 'dog', true);

            expect(ensure_dir_stub).to.have.been.calledWith(TMP_PATH_TEST);
            expect(write_file_stub).to.have.been.calledWith(expected_log_dest, '');
            expect(pino_stub.firstCall.args[0].level).to.equal('debug');
            expect(pino_stub.firstCall.args[1]).to.equal(expected_log_dest);
        });
    });

    describe('Test processTable, insertTransaction, validateIndices & getHashDBI functions', () => {
        let processTable;

        const revert_process_table = async () => {
            await fs.copy(OLD_ENV_SCHEMA, SCHEMA_PATH_TEST);
            await fs.copy(OLD_ENV_TRANSACTIONS, TRANSACTIONS_PATH_TEST);
        };

        before(async () => {
            // The tmp schema dir is created in getSchemaTable so we need to create it here to test processTable.
            await fs.emptyDir(tmp_schema_path_test);
            processTable = reindex_rw.__get__('processTable');
        });

        after(async () => {
            await revert_process_table();
        });

        // These tests don't use any stubs. They will reindex the tables in reindexTestDir schema & transactions.
        // There are no expects in some of the tests because the reindex code contains validation and asserts.
        it('Test that a table is successfully processed happy path', async () => {
            await processTable('dev', 'dog', the_schema_path_dev_test, false, tmp_schema_path_test);
        });

        it('Test that a transaction table is successfully processed happy path', async () => {
            await processTable('dev', 'dog', the_tran_schema_path_dev_test, true, tmp_schema_path_test);
        });

        it('Test error is thrown and ignored if reindex called on already indexed environment', async () => {
            global.old_lmdb_map = undefined;
            await processTable('dev', 'dog', the_schema_path_dev_test, false, tmp_schema_path_test);
            expect(logger_notify_stub).to.have.been.calledWith('dev.dog file is not from the old environment and has been skipped');
        });

        it('Test error is thrown if environment does not exist', async () => {
            await revert_process_table();
            let error;
            try {
                await processTable('dev', 'no_dog', the_schema_path_dev_test, false, tmp_schema_path_test);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal('invalid environment');
        });

        it('Test an error from the validator handled correctly', async () => {
            await revert_process_table();
            const validate_indices_stub = sandbox.stub().throws(new Error('validation error'));
            const validate_indices_rw = reindex_rw.__set__('validateIndices', validate_indices_stub);
            await test_utils.assertErrorAsync(processTable, ['dev', 'dog', the_schema_path_dev_test, false, tmp_schema_path_test], new Error('validation error'));
            validate_indices_rw();
        });
    });

    describe('Test validateIndex function', () => {
        let validateIndex;
        let check_is_blod_stub;

        const env_test = {
            "dbis": {
                "__blob__": {
                    "get": () => undefined
                },
                "name": {
                    "doesExist": () => undefined
                }
            }
        };

        before(() => {
            validateIndex = reindex_rw.__get__('validateIndex');
            check_is_blod_stub = sandbox.stub(lmdb_common, 'checkIsBlob');
        });

        it('Test assert fails if blob entry is not found', () => {
            check_is_blod_stub.returns(true);
            validateIndex(env_test, 'name', 'jerry', '123abc');
            expect(pino_info_fake).to.have.been.calledWith('Validate indices did not find blob value in new DBI: jerry. Hash: 123abc');
            expect(pino_error_fake.firstCall.args[0].message).to.include('Expected values to be strictly deep-equal:\n\nfalse !== true\n');
        });

        it('Test assert fails if value not found', () => {
            check_is_blod_stub.returns(false);
            validateIndex(env_test, 'name', 'jerry', '123abc');
            expect(pino_info_fake).to.have.been.calledWith('Validate indices did not find value in new DBI: jerry. Hash: 123abc');
            expect(pino_error_fake.firstCall.args[0].message).to.include('Expected values to be strictly deep-equal');
        });
    });
});
