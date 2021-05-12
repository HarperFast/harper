'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
const rewire = require('rewire');
const test_util = require('../test_utils');
const harper_logger = require('../../utility/logging/harper_logger');
const env_mangr = require('../../utility/environment/environmentManager');
const install_user_permission = require('../../utility/install_user_permission');
const hdb_license = require('../../utility/registration/hdb_license');
const hdbInfoController = require('../../data_layer/hdbInfoController');
const schema_describe = require('../../data_layer/schemaDescribe');
const upgrade = require('../../bin/upgrade');
const stop = require('../../bin/stop');
let run_rw;

describe('Test run module', () => {
    const TEST_ERROR = 'I am a unit test error test';
    const final_log_notify_stub = sinon.stub().callsFake(() => {});
    const final_log_error_stub = sinon.stub().callsFake(() => {});
    const final_log_info_stub = sinon.stub().callsFake(() => {});
    const final_logger_fake = {
        notify: final_log_notify_stub,
        error: final_log_error_stub,
        info: final_log_info_stub
    };
    let console_log_stub;
    let console_error_stub;
    let process_exit_stub;

    before(() => {
        process_exit_stub = sinon.stub(process, 'exit');
        console_log_stub = sinon.stub(console, 'log');
        console_error_stub = sinon.stub(console, 'error');
        sinon.stub(harper_logger, 'finalLogger').returns(final_logger_fake);
        test_util.preTestPrep();
        run_rw = rewire('../../bin/run');
    });

    after(() => {
        sinon.restore();
        rewire('../../bin/run');
    });

    describe('Test run function', () => {
        const is_server_running_stub = sinon.stub();
        const is_hdb_installed_stub = sinon.stub();
        const check_trans_log_env_exists_stub = sinon.stub();
        const launch_ipc_server_stub = sinon.stub();
        const launch_hdb_server_stub = sinon.stub();
        const p_install_install_stub = sinon.stub();
        let is_hdb_installed_rw;
        let is_server_running_rw;
        let check_trans_log_env_exists_rw;
        let launch_ipc_server_rw;
        let launch_hdb_server_rw;
        let p_install_install_rw;
        let get_ver_update_info_stub;
        let upgrade_stub;
        let run;

        before(() => {
            is_server_running_rw = run_rw.__set__('isServerRunning', is_server_running_stub);
            is_hdb_installed_rw = run_rw.__set__('isHdbInstalled', is_hdb_installed_stub);
            check_trans_log_env_exists_rw = run_rw.__set__('checkTransactionLogEnvironmentsExist', check_trans_log_env_exists_stub);
            launch_ipc_server_rw = run_rw.__set__('launchIPCServer', launch_ipc_server_stub);
            launch_hdb_server_rw = run_rw.__set__('launchHdbServer', launch_hdb_server_stub);
            p_install_install_rw = run_rw.__set__('p_install_install', p_install_install_stub);
            get_ver_update_info_stub = sinon.stub(hdbInfoController, 'getVersionUpdateInfo');
            upgrade_stub = sinon.stub(upgrade, 'upgrade');
            run = run_rw.__get__('run');
        });

        beforeEach(() => {
            sinon.resetHistory();
        });

        after(() => {
            is_server_running_rw();
            is_hdb_installed_rw();
            check_trans_log_env_exists_rw();
            launch_ipc_server_rw();
            launch_hdb_server_rw();
            //run_sandbox.restore();
        });

        it('Test run happy path, all functions are called as expected', async () => {
            is_server_running_stub.resolves(false);
            is_hdb_installed_stub.resolves(true);
            get_ver_update_info_stub.resolves(undefined);
            await run();

            expect(check_trans_log_env_exists_stub).to.have.been.called;
            expect(launch_ipc_server_stub).to.have.been.called;
            expect(launch_hdb_server_stub).to.have.been.called;
        });

        it('Test server running msg is returned', async () => {
            is_server_running_stub.resolves(true);
            await run();

            expect(console_log_stub).to.have.been.calledWith('HarperDB is already running.');
            expect(final_log_notify_stub).to.have.been.calledWith('HarperDB is already running.');
        });

        it('Test error from isServerRunning is handled correctly', async () => {
            is_server_running_stub.throws(TEST_ERROR);
            await run();

            expect(console_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
            expect(final_log_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
            expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
        });

        it('Test upgrade is called if upgrade version permits', async () => {
            is_server_running_stub.resolves(false);
            is_hdb_installed_stub.resolves(true);
            get_ver_update_info_stub.resolves({ upgrade_version: '9.9.9' });
            await run();

            expect(upgrade_stub).to.have.been.calledWith({ upgrade_version: '9.9.9' });
            expect(console_log_stub).to.have.been.calledWith('Upgrade complete.  Starting HarperDB.');
        });

        it('Test upgrade error with version is handled correctly', async () => {
            is_server_running_stub.resolves(false);
            is_hdb_installed_stub.resolves(true);
            get_ver_update_info_stub.resolves({ upgrade_version: '9.9.9' });
            upgrade_stub.throws(TEST_ERROR);
            await run();

            expect(console_error_stub.getCall(0).firstArg).to.equal('Got an error while trying to upgrade your HarperDB instance to version 9.9.9.  Exiting HarperDB.');
            expect(final_log_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
            expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
        });

        it('Test upgrade error without version is handled correctly', async () => {
            is_server_running_stub.resolves(false);
            is_hdb_installed_stub.resolves(true);
            get_ver_update_info_stub.throws(TEST_ERROR);
            await run();

            expect(console_error_stub.getCall(0).firstArg).to.equal('Got an error while trying to upgrade your HarperDB instance.  Exiting HarperDB.');
            expect(final_log_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
            expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
        });

        it('Test install is called if HDB not installed', async () => {
            is_server_running_stub.resolves(false);
            is_hdb_installed_stub.resolves(false);
            await run();

            expect(p_install_install_stub).to.have.been.called;
        });

        it('Test error from install is handled as expected', async () => {
            is_server_running_stub.resolves(false);
            is_hdb_installed_stub.resolves(false);
            p_install_install_stub.throws(TEST_ERROR);
            await run();

            expect(console_error_stub.getCall(0).firstArg).to.equal('There was an error during install, check install_log.log for more details.  Exiting.');
            expect(final_log_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
            expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
        });

        it('Test error from isHdbInstalled is handled as expected', async () => {
            is_server_running_stub.resolves(false);
            is_hdb_installed_stub.throws(TEST_ERROR);
            await run();

            expect(console_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
            expect(final_log_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
            expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
        });
    });

    describe('Test checkTransactionLogEnvironmentsExist function', async () => {
        const open_create_trans_env_stub = sinon.stub();
        const describe_results_test = {
            "northnwd": {
                "customers": {
                }
            }
        };
        let open_create_trans_env_rw;
        let checkTransactionLogEnvironmentsExist;

        before(() => {
            sinon.stub(env_mangr, 'getDataStoreType').returns('lmdb');
            sinon.stub(schema_describe, 'describeAll').resolves(describe_results_test);
            open_create_trans_env_rw = run_rw.__set__('openCreateTransactionEnvironment', open_create_trans_env_stub);
            checkTransactionLogEnvironmentsExist = run_rw.__get__('checkTransactionLogEnvironmentsExist');
        });

        after(() => {
            open_create_trans_env_rw();
        });

        it('Test checkTransactionLogEnvironmentsExist happy path', async () => {
            await checkTransactionLogEnvironmentsExist();
            expect(open_create_trans_env_stub.getCall(0).args).to.eql(['system', 'hdb_table']);
            expect(open_create_trans_env_stub.getCall(1).args).to.eql(['system', 'hdb_attribute']);
            expect(open_create_trans_env_stub.getCall(2).args).to.eql(['system', 'hdb_schema']);
            expect(open_create_trans_env_stub.getCall(3).args).to.eql(['system', 'hdb_user']);
            expect(open_create_trans_env_stub.getCall(4).args).to.eql(['system', 'hdb_role']);
            expect(open_create_trans_env_stub.getCall(5).args).to.eql(['system', 'hdb_job']);
            expect(open_create_trans_env_stub.getCall(6).args).to.eql(['system', 'hdb_license']);
            expect(open_create_trans_env_stub.getCall(7).args).to.eql(['system', 'hdb_info']);
            expect(open_create_trans_env_stub.getCall(8).args).to.eql(['system', 'hdb_nodes']);
            expect(open_create_trans_env_stub.getCall(9).args).to.eql(['system', 'hdb_temp']);
            expect(open_create_trans_env_stub.getCall(10).args).to.eql(['northnwd', 'customers']);
            expect(final_log_info_stub.getCall(0).firstArg).to.equal('Checking Transaction Environments exist');
            expect(final_log_info_stub.getCall(1).firstArg).to.equal('Finished checking Transaction Environments exist');
        });
    });

    describe('Test openCreateTransactionEnvironment function', () => {
        let lmdb_create_txn_env_stub = sinon.stub();
        let openCreateTransactionEnvironment;

        before(() => {
            run_rw.__set__('lmdb_create_txn_environment', lmdb_create_txn_env_stub);
            openCreateTransactionEnvironment = run_rw.__get__('openCreateTransactionEnvironment');
        });

        beforeEach(() => {
            sinon.resetHistory();
        });

        it('Test openCreateTransactionEnvironment happy path', async () => {
            const expected_obj = {
                "schema": "unit_tests",
                "table": "are_amazing",
                "hash_attribute": undefined
            };
            await openCreateTransactionEnvironment('unit_tests', 'are_amazing');

            expect(lmdb_create_txn_env_stub).to.have.been.calledWith(sinon.match(expected_obj));
        });

        it('Test openCreateTransactionEnvironment sad path', async () => {
            lmdb_create_txn_env_stub.throws(new Error(TEST_ERROR));
            await openCreateTransactionEnvironment('unit_tests', 'are_amazing');

            expect(console_error_stub.getCall(0).firstArg).to.equal('Unable to create the transaction environment for unit_tests.are_amazing, due to: I am a unit test error test');
            expect(final_log_error_stub.getCall(0).firstArg).to.equal('Unable to create the transaction environment for unit_tests.are_amazing, due to: I am a unit test error test');
        });
    });

    describe('Test launchHdbServer function', () => {
        const is_port_taken_stub = sinon.stub();
        const foreground_handler_stub = sinon.stub();
        const fork_stub = sinon.stub();
        let fork_rw;
        let foreground_handler_rw;
        let is_port_taken_rw;
        let check_perms_stub;
        let license_search_stub;
        let launchHdbServer;

        before(() => {
            launchHdbServer = run_rw.__get__('launchHdbServer');
            is_port_taken_rw = run_rw.__set__('isPortTaken', is_port_taken_stub);
            foreground_handler_rw = run_rw.__set__('foregroundHandler', foreground_handler_stub);
            fork_rw = run_rw.__set__('fork', fork_stub);
            check_perms_stub = sinon.stub(install_user_permission, 'checkPermission');
            license_search_stub = sinon.stub(hdb_license, 'licenseSearch');
        });

        beforeEach(() => {
            sinon.resetHistory();
        });

        after(() => {
            foreground_handler_rw();
        });

        it('Test all everything is called as expected happy path', async () => {
            is_port_taken_stub.resolves(false);
            license_search_stub.returns({ ram_allocation: 1024 });
            await launchHdbServer();

            expect(check_perms_stub).to.have.been.called;
            expect(fork_stub.args[0][0]).to.include('harperdb/server/hdbServer.js');
            expect(fork_stub.args[0][1]).to.eql([undefined]);
            expect(fork_stub.args[0][2].detached).to.equal(true);
            expect(fork_stub.args[0][2].stdio).to.equal('ignore');
            expect(fork_stub.args[0][2].execArgv).to.eql(['--max-old-space-size=1024']);
            expect(foreground_handler_stub).to.have.been.called;
        });

        it('Test happy path when fork args are compiled extension', async () => {
            const terms_test = {
                HDB_SETTINGS_NAMES: {
                    SERVER_PORT_KEY: 'SERVER_PORT'
                },
                HDB_SETTINGS_DEFAULT_VALUES: {
                    SERVER_PORT: 9925
                },
                HDB_PROC_NAME: 'hdbServer.jsc',
                CODE_EXTENSION: 'jsc',
                COMPILED_EXTENSION: 'jsc',
                RAM_ALLOCATION_ENUM: {
                    DEFAULT: 512
            }

            };
            const terms_rw = run_rw.__set__('terms', terms_test);
            is_port_taken_stub.resolves(false);
            license_search_stub.returns({ ram_allocation: 1024 });
            await launchHdbServer();
            terms_rw();

            expect(check_perms_stub).to.have.been.called;
            expect(fork_stub.args[0][0]).to.include('node_modules/bytenode/cli.js');
            expect(fork_stub.args[0][1][0]).to.include('harperdb/server/hdbServer.jsc');
            expect(fork_stub.args[0][2].detached).to.equal(true);
            expect(fork_stub.args[0][2].stdio).to.equal('ignore');
            expect(fork_stub.args[0][2].execArgv).to.eql(['--max-old-space-size=1024']);
            expect(foreground_handler_stub).to.have.been.called;
        });

        it('Test error from get server port is handled as expected', async () => {
            const is_empty_rw = run_rw.__set__('isEmpty', sinon.stub().throws(TEST_ERROR));
            await launchHdbServer();
            is_empty_rw();

            expect(console_error_stub.getCall(0).firstArg).to.equal('Error getting HDB server port from environment variables');
            expect(final_log_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
            expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
        });

        it('Test message is logged and process exited if port taken', async () => {
            is_port_taken_stub.resolves(true);
            await launchHdbServer();

            expect(console_log_stub.getCall(0).firstArg).to.equal('Port: 9925 is being used by another process and cannot be used by the HDB server. Please update the HDB server port in the HDB config/settings.js file.');
            expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
        });

        it('Test error from isPortTaken is handled as expected', async () => {
            is_port_taken_stub.throws(TEST_ERROR);
            await launchHdbServer();

            expect(console_error_stub.getCall(0).firstArg).to.equal('Error checking for port 9925. Check log for more details.');
            expect(final_log_error_stub.getCall(0).firstArg.name).to.equal(TEST_ERROR);
            expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
        });

        it('Test error from checkPermission is handled as expected', async () => {
            is_port_taken_stub.resolves(false);
            const err = new Error(TEST_ERROR);
            check_perms_stub.throws(err);
            await launchHdbServer();

            expect(console_error_stub.getCall(0).firstArg).to.equal(TEST_ERROR);
            expect(final_log_error_stub.getCall(0).firstArg).to.eql(err);
            expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
        });

        it('Test error from fork is handled as expected', async () => {
            is_port_taken_stub.resolves(false);
            check_perms_stub.returns();
            license_search_stub.returns({ ram_allocation: 1024 });
            fork_stub.throws(TEST_ERROR);
            await launchHdbServer();

            expect(console_error_stub.getCall(0).firstArg).to.equal('There was an error starting the HDB server, check the log for more details.');
            expect(final_log_error_stub.getCall(0).firstArg.name).to.eql(TEST_ERROR);
            expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
        });

        it('Test error from foregroundHandler is handled as expected', async () => {
            is_port_taken_stub.resolves(false);
            check_perms_stub.returns();
            license_search_stub.returns({ ram_allocation: 1024 });
            fork_stub.returns();
            foreground_handler_stub.throws(TEST_ERROR);
            await launchHdbServer();

            expect(console_error_stub.getCall(0).firstArg).to.equal('There was an error foreground handler, check the log for more details.');
            expect(final_log_error_stub.getCall(0).firstArg.name).to.eql(TEST_ERROR);
            expect(process_exit_stub.getCall(0).firstArg).to.equal(1);
        });
    });
    
    describe('Test foregroundHandler function', () => {
        const process_exit_handler_stub = sinon.stub();
        const ipc_child_unref_stub = sinon.stub().callsFake(() => {});
        const fake_ipc_child = { unref: ipc_child_unref_stub };
        const child_unref_stub = sinon.stub().callsFake(() => {});
        const fake_child = { unref: child_unref_stub };
        let process_exit_handler_rw;
        let foregroundHandler;
        let stop_stub;

        before(() => {
            process_exit_handler_rw = run_rw.__set__('processExitHandler', process_exit_handler_stub);
            run_rw.__set__('ipc_child', fake_ipc_child);
            run_rw.__set__('child', fake_child);
            foregroundHandler = run_rw.__get__('foregroundHandler');
            stop_stub = sinon.stub(stop, 'stop');
        });

        beforeEach(() => {
            sinon.resetHistory();
        });

        it('Test happy path non foreground', () => {
            foregroundHandler();

            expect(ipc_child_unref_stub).to.have.been.called;
            expect(child_unref_stub).to.have.been.called;
            expect(process_exit_stub.getCall(0).firstArg).to.equal(0);
        });
    });

});
