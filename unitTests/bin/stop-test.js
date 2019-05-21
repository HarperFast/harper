'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const expect = chai.expect;
const ps_list = require('../../utility/psList');
const os = require('os');
const signal = require('../../utility/signalling');
const hdb_terms = require('../../utility/hdbTerms');
const logger = require('../../utility/logging/harper_logger');
const rewire = require('rewire');
let stop = rewire('../../bin/stop');

chai.use(sinon_chai);

const RESTART_RESPONSE_SOFT = `Restarting HarperDB. This may take up to ${hdb_terms.RESTART_TIMEOUT_MS/1000} seconds.`;
const RESTART_RESPONSE_HARD = `Force restarting HarperDB`;
const HDB_PROC_END_TIMEOUT = 5;

/**
 * Unit tests for bin/stop.js
 */
describe('Test stop.js' , () => {
    let log_error_stub;
    let log_info_stub;
    let console_log_spy;
    let console_error_stub;
    let find_ps_stub;
    let harper_instances_fake = [{
        pid: 2235,
        name: 'node',
        cmd:'Desktop/harperdb/server/hdb_express.js',
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
        sinon.resetHistory();
    });

    before(() => {
        log_error_stub = sinon.stub(logger, 'error');
        log_info_stub = sinon.stub(logger, 'info');
        // I had console.log as a stub but it was stopping npm test from running on the command line.
        console_log_spy = sinon.spy(console, 'log');
        console_error_stub = sinon.stub(console, 'error');
        find_ps_stub = sinon.stub(ps_list, 'findPs');
    });

    after(() => {
        stop = rewire('../../bin/stop');
        log_error_stub.restore();
        log_info_stub.restore();
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
            signal_stub = sinon.stub(signal, 'signalRestart').returns();
        });

        it('should return restart response hard', async () => {
            json_message_fake.force = 'true';
            let result = await stop.restartProcesses(json_message_fake);

            expect(signal_stub).to.have.been.calledOnce;
            expect(signal_stub).to.have.been.calledWith(json_message_fake.force);
            expect(result).to.equal(RESTART_RESPONSE_HARD);
        });

        it('should return restart response soft', async () => {
            json_message_fake.force = false;
            let result = await stop.restartProcesses(json_message_fake);

            expect(signal_stub).to.have.been.calledOnce;
            expect(signal_stub).to.have.been.calledWith(json_message_fake.force);
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
            expect(log_error_stub).to.have.been.calledOnce;
            expect(log_error_stub).to.have.been.calledWith(return_err);
        });
    });

    /**
     * Tests for stop function
     */
    context('stop', () => {
        let kill_procs_stub = sinon.stub();
        let kill_procs_rewire;

        before(() => {
            kill_procs_rewire = stop.__set__('killProcs', kill_procs_stub);
            sinon.resetHistory();

        });

        after(() => {
            kill_procs_rewire();
        });

        it('should call killProcs and logger with valid parameters', async () => {
            await stop.stop();

            expect(console_log_spy).to.have.been.calledOnce;
            expect(console_log_spy).to.have.been.calledWith('Stopping HarperDB.');
            expect(kill_procs_stub).to.have.been.calledTwice;
            expect(log_info_stub).to.have.been.calledTwice;
            expect(kill_procs_stub).to.have.been.calledWith(hdb_terms.HDB_PROC_NAME, hdb_terms.HDB_PROC_DESCRIPTOR);
            expect(log_info_stub).to.have.been.calledWith(`Stopping ${hdb_terms.HDB_PROC_NAME} - ${hdb_terms.HDB_PROC_DESCRIPTOR}.`);
            expect(kill_procs_stub).to.have.been.calledWith(hdb_terms.SC_PROC_NAME, hdb_terms.SC_PROC_DESCRIPTOR);
            expect(log_info_stub).to.have.been.calledWith(`Stopping ${hdb_terms.SC_PROC_NAME} - ${hdb_terms.SC_PROC_DESCRIPTOR}.`);
        });

        it('should catch error from killProcs and console error it', async () => {
            let kill_procs_err = 'An error occurred killing the process';
            kill_procs_stub.throws(new Error(kill_procs_err));
            let result = await stop.stop();

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
        let process_kill_stub = sinon.stub();
        let process_kill_rewire;
        let check_hdb_proc_end_stub = sinon.stub();
        let check_hdb_end_rewire;
        let kill_procs;

        before(() => {
            sinon.resetHistory();
            os_user_info_stub = sinon.stub(os, 'userInfo');
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
        let async_set_timeout_stub = sinon.stub().resolves();
        // fake responses from ps_list calls
        let hdb_instance_first = [{
            pid: 2235,
            name: 'node',
            cmd:'Desktop/harperdb/server/hdb_express.js',
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
            cmd:'Desktop/harperdb/server/hdb_express.js',
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
            find_ps_stub.restore();
            sinon.resetHistory();
            find_ps_stub = sinon.stub(ps_list, 'findPs');
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
            find_ps_stub.resolves(hdb_instance_first);
            await check_hdb_procs_end(hdb_terms.HDB_PROC_NAME);

            expect(async_set_timeout_stub).to.have.callCount(HDB_PROC_END_TIMEOUT);
            expect(log_error_stub).to.have.been.calledOnce;
            expect(log_error_stub).to.have.been.calledWith('Unable to stop all the processes');
            expect(console_error_stub).to.have.been.calledOnce;
            expect(console_error_stub).to.have.been.calledWith('Unable to stop all the processes');
        });
    });
});
