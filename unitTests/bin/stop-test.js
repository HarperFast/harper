'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const expect = chai.expect;
const ps_list = require('../../utility/psList');
const os = require('os');
const path = require('path');
const hdb_utils = require('../../utility/common_utils');
const signalling = require('../../utility/signalling');
const hdb_terms = require('../../utility/hdbTerms');
const logger = require('../../utility/logging/harper_logger');
const rewire = require('rewire');
let stop;

chai.use(sinon_chai);

const RESTART_RESPONSE_SOFT = `Restarting HarperDB. This may take up to ${hdb_terms.RESTART_TIMEOUT_MS/1000} seconds.`;
const RESTART_RESPONSE_HARD = `Force restarting HarperDB`;
const HDB_PROC_END_TIMEOUT = 5;

/**
 * Unit tests for bin/stop.js
 */
describe('Test stop.js' , () => {
    let sandbox;
    let log_error_stub;
    let log_info_stub;
    let console_log_spy;
    let console_error_stub;
    let find_ps_stub;
    let final_logger_error_stub;
    let final_logger_info_stub;
    let harper_instances_fake = [{
        pid: 2235,
        name: 'node',
        cmd:'Desktop/harperdb/server/hdbServer.js',
        ppid: 1,
        uid: 501,
        cpu: 0,
        memory: 0.6 },
        {
        pid: 2245,
        name: 'node',
        cmd: '/Desktop/harperdb/server/socketcluster/Server.js',
        ppid: 2235,
        uid: 501,
        cpu: 0,
        memory: 0.6
    }];

    afterEach(() => {
        sandbox.resetHistory();
    });

    before(() => {
        sandbox = sinon.createSandbox();
        log_error_stub = sandbox.stub(logger, 'error');
        log_info_stub = sandbox.stub(logger, 'info');
        // I had console.log as a stub but it was stopping npm test from running on the command line.
        ({ final_logger_error_stub, final_logger_info_stub } = test_util.stubFinalLogger(sandbox, logger));
        stop = rewire('../../bin/stop');
        console_log_spy = sandbox.spy(console, 'log');
        console_error_stub = sandbox.stub(console, 'error');
        find_ps_stub = sandbox.stub(ps_list, 'findPs');
    });

    after(() => {
        rewire('../../bin/stop');
        sandbox.restore();
    });

    /**
     * Tests for restartProcesses function
     */
    context('restart processes', () => {
        let signal_stub;
        let json_message_fake = {
            operation: 'restart',
            force: false
        };

        before(() => {
            signal_stub = sandbox.stub(signalling, 'signalRestart').returns();
        });
        
        after(() => {
            signal_stub.restore();
        });

        it('should return restart response hard', async () => {
            json_message_fake.force = 'true';
            let result = await stop.restartProcesses(json_message_fake);

            expect(signal_stub).to.have.been.calledOnce;
            expect(signal_stub.args[0][0].force).to.eql(true);
            expect(result).to.equal(RESTART_RESPONSE_HARD);
        });

        it('should return restart response soft', async () => {
            json_message_fake.force = false;
            let result = await stop.restartProcesses(json_message_fake);

            expect(signal_stub).to.have.been.calledOnce;
            expect(signal_stub.args[0][0].force).to.eql(false);
            expect(result).to.equal(RESTART_RESPONSE_SOFT);
        });

        it('should catch error and log it', async () => {
            let signal_restart_err = 'Invalid force value, must be a boolean.';
            let return_err = `There was an error restarting HarperDB. Error: ${signal_restart_err}` ;
            signal_stub.throws(new Error(signal_restart_err));
            // This function doesn't throw an error it returns one, that is why my test isn't in a t/c block.
            let result = await stop.restartProcesses(json_message_fake);

            expect(signal_stub).to.have.been.calledOnce;
            expect(result).to.equal(return_err);
            expect(final_logger_error_stub).to.have.been.calledOnce;
            expect(final_logger_error_stub).to.have.been.calledWith(return_err);
        });
    });

    describe('Test restartService function', () => {
        let signal_stub;

        before(() => {
            signal_stub = sandbox.stub(signalling, 'signalRestart').returns();
        });

        it('Test missing service error thrown', () => {
            const expected_err = test_util.generateHDBError("'service' is required", 400);
            test_util.assertErrorSync(stop.restartService, [ { operation: "restart_service" }], expected_err);
        });

        it('Test invalid service error thrown', () => {
            const expected_err = test_util.generateHDBError("Invalid service", 400);
            test_util.assertErrorSync(stop.restartService, [ { operation: "restart_service", service: "no_service" }], expected_err);
        });

        it('Test signal restart called happy path', () => {
            const expected_event = {
                "originator": process.pid,
                "force": false,
                "service": "custom_functions"
            };
            const json_message_fake = {
                operation: 'restart',
                service: 'custom_functions'
            };
            stop.restartService(json_message_fake);
            expect(signal_stub.args[0][0]).to.eql(expected_event);
        });
    });

    /**
     * Tests for stop function
     */
    context('stop', () => {
        let kill_procs_stub;
        let kill_procs_rewire;
        let stop_process_stub;

        before(() => {
            stop_process_stub = sandbox.stub(hdb_utils, 'stopProcess');
            kill_procs_stub = sandbox.stub();
            kill_procs_rewire = stop.__set__('killProcs', kill_procs_stub);
        });
        
        afterEach(() => {
            sandbox.resetHistory();
        });

        after(() => {
            kill_procs_rewire();
        });

        it('should call killProcs and logger with valid parameters', async () => {
            await stop.stop();

            expect(console_log_spy).to.have.been.calledOnce;
            expect(console_log_spy).to.have.been.calledWith('Stopping HarperDB.');
            expect(kill_procs_stub).to.have.been.calledTwice;
            expect(final_logger_info_stub.callCount).to.equal(4);
            expect(kill_procs_stub.getCall(0).args[0]).to.equal(path.resolve('../server/socketcluster',hdb_terms.SC_PROC_NAME), hdb_terms.SC_PROC_DESCRIPTOR);
            expect(kill_procs_stub.getCall(1).args[0]).to.equal(path.resolve('../server', hdb_terms.HDB_PROC_NAME), hdb_terms.HDB_PROC_DESCRIPTOR);
            expect(final_logger_info_stub).to.have.been.calledWith(`Stopping ${hdb_terms.HDB_PROC_NAME} - ${hdb_terms.HDB_PROC_DESCRIPTOR}.`);
            expect(final_logger_info_stub).to.have.been.calledWith(`Stopping ${hdb_terms.SC_PROC_NAME} - ${hdb_terms.SC_PROC_DESCRIPTOR}.`);
            expect(stop_process_stub.getCall(0).args[0]).to.equal(path.resolve('../server/ipc', hdb_terms.IPC_SERVER_MODULE));
            expect(stop_process_stub.getCall(1).args[0]).to.equal(path.resolve('../server/customFunctions', hdb_terms.CUSTOM_FUNCTION_PROC_NAME));
        });

        it('should catch error from killProcs and console error it', async () => {
            let kill_procs_err = 'An error occurred killing the process';
            kill_procs_stub.throws(new Error(kill_procs_err));
            let result = undefined;
            try {
                result = await stop.stop();
            } catch(err) {
                result = err;
            }

            expect(result).to.be.an.instanceOf(Error);
            expect(result.message).to.equal(kill_procs_err);
            expect(console_error_stub).to.have.been.calledOnce;
        });
    });

    /**
     * Tests for killProcs function
     */
    context('kill process', () => {
        let os_user_info_stub;
        let process_kill_stub;
        let process_kill_rewire;
        let check_hdb_proc_end_stub;
        let check_hdb_end_rewire;
        let kill_procs;

        before(() => {
            process_kill_stub = sandbox.stub();
            check_hdb_proc_end_stub = sandbox.stub();
            os_user_info_stub = sandbox.stub(os, 'userInfo');
            kill_procs = stop.__get__('killProcs');
            process_kill_rewire = stop.__set__('process.kill', process_kill_stub);
            check_hdb_end_rewire = stop.__set__('checkHdbProcsEnd', check_hdb_proc_end_stub);
        });

        after(() => {
            os_user_info_stub.restore();
            kill_procs();
            process_kill_rewire();
            check_hdb_end_rewire();
        });

        it('should console log no instances of HDB running', async () => {
            find_ps_stub.resolves([]);
            await kill_procs(hdb_terms.HDB_PROC_NAME, hdb_terms.HDB_PROC_DESCRIPTOR);

            expect(os_user_info_stub).to.have.been.calledOnce;
            expect(find_ps_stub).to.have.been.calledOnce;
            expect(find_ps_stub).to.have.been.calledWith(hdb_terms.HDB_PROC_NAME);
            expect(console_log_spy).to.have.been.calledOnce;
            expect(console_log_spy).to.have.been.calledWith(`No instances of ${hdb_terms.HDB_PROC_DESCRIPTOR} are running.`);
        });

        it('should call process kill for each process', async () => {
            find_ps_stub.resolves(harper_instances_fake);
            os_user_info_stub.returns({uid: 0});
            await kill_procs(hdb_terms.HDB_PROC_NAME, hdb_terms.HDB_PROC_DESCRIPTOR);

            expect(os_user_info_stub).to.have.been.calledOnce;
            expect(find_ps_stub).to.have.been.called;
            expect(find_ps_stub).to.have.been.calledWith(hdb_terms.HDB_PROC_NAME);
            expect(process_kill_stub).to.have.been.calledTwice;
            expect(process_kill_stub).to.have.been.calledWith(2235);
            expect(process_kill_stub).to.have.been.calledWith(2245);
            expect(check_hdb_proc_end_stub).to.have.been.calledOnce;
            expect(check_hdb_proc_end_stub).to.have.been.calledWith(hdb_terms.HDB_PROC_NAME);
        });

        it('should console error from process kill', async () => {
            let process_kill_err = 'Invalid argument';
            process_kill_stub.throws(new Error(process_kill_err));
            await kill_procs(hdb_terms.HDB_PROC_NAME, hdb_terms.HDB_PROC_DESCRIPTOR);

            expect(console_error_stub).to.have.been.calledTwice;
        });

        it('should catch thrown error from checkHdbProcsEnd', async () => {
            let os_user_info_err = 'Error finding user info';
            check_hdb_proc_end_stub.throws(new Error(os_user_info_err));
            process_kill_stub.returns();
            let error;

            try {
                await kill_procs(hdb_terms.HDB_PROC_NAME, hdb_terms.HDB_PROC_DESCRIPTOR);
            } catch(err) {
                error = err;
            }

            expect(check_hdb_proc_end_stub).to.have.been.calledOnce;
            expect(error).to.be.an.instanceOf(Error);
            expect(error.message).to.equal(os_user_info_err);
        });
    });

    /**
     * Tests for checkHdbProcsEnd function
     */
    context('check HDB processes have finished', () => {
        let check_hdb_procs_end;
        let async_set_timeout_rewire;
        let async_set_timeout_stub;
        // fake responses from ps_list calls
        let hdb_instance_first = [{
            pid: 2235,
            name: 'node',
            cmd:'Desktop/harperdb/server/hdbServer.js',
            ppid: 1,
            uid: 501,
            cpu: 0,
            memory: 0.6 },
            {
            pid: 2245,
            name: 'node',
            cmd: '/Desktop/harperdb/server/socketcluster/Server.js',
            ppid: 2235,
            uid: 501,
            cpu: 0,
            memory: 0.6
            },
            {
            pid: 2266,
            name: 'node',
            cmd: '/Desktop/harperdb/server/socketcluster/Server.js',
            ppid: 23,
            uid: 501,
            cpu: 0,
            memory: 0.6
        }];

        let hdb_instance_second = [{
            pid: 2235,
            name: 'node',
            cmd:'Desktop/harperdb/server/hdbServer.js',
            ppid: 1,
            uid: 501,
            cpu: 0,
            memory: 0.6 },
            {
            pid: 2245,
            name: 'node',
            cmd: '/Desktop/harperdb/server/socketcluster/Server.js',
            ppid: 2235,
            uid: 501,
            cpu: 0,
            memory: 0.6
        }];

        let hdb_instance_third = [];

        before(() => {
            // was getting funny behaviour from stub so restored it to get onCalls working.
            async_set_timeout_stub = sandbox.stub().resolves();
            find_ps_stub.restore();
            sandbox.resetHistory();
            find_ps_stub = sandbox.stub(ps_list, 'findPs');
            find_ps_stub.onSecondCall().resolves(hdb_instance_first);
            find_ps_stub.onThirdCall().resolves(hdb_instance_second);
            find_ps_stub.resolves(hdb_instance_third);
            check_hdb_procs_end = stop.__get__('checkHdbProcsEnd');
            async_set_timeout_rewire = stop.__set__('async_set_timeout', async_set_timeout_stub);
        });

        after(() => {
            check_hdb_procs_end();
            async_set_timeout_rewire();
        });

        it('should call find ps three times', async () => {
            await check_hdb_procs_end(hdb_terms.HDB_PROC_NAME);

            expect(log_error_stub).to.have.not.been.called;
            expect(console_error_stub).to.have.not.been.called;
        });

        it('should call unable to stop all processes', async () => {
            sandbox.resetHistory();
            find_ps_stub.resolves(hdb_instance_first);
            await check_hdb_procs_end(hdb_terms.HDB_PROC_NAME);

            expect(async_set_timeout_stub).to.have.callCount(HDB_PROC_END_TIMEOUT);
            expect(final_logger_error_stub).to.have.been.calledOnce;
            expect(final_logger_error_stub).to.have.been.calledWith('Unable to stop all the processes');
            expect(console_error_stub).to.have.been.calledOnce;
            expect(console_error_stub).to.have.been.calledWith('Unable to stop all the processes');
        });
    });
});
