'use strict';

const chai = require('chai');
const sinon = require('sinon');
const rewire = require('rewire');
const { expect } = chai;
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
const harper_logger = require('../../../utility/logging/harper_logger');
const enterprise_util = require('../../../utility/enterpriseInitialization');
const cluster_util = require('../../../server/clustering/clusterUtilities');
let hdb_parent_ipc_handlers;

describe('Test hdbParentIpcHandlers module', () => {
    const TEST_ERROR = 'I am a test error';
    const sandbox = sinon.createSandbox();
    let log_error_stub;
    let log_info_stub;
    let log_trace_stub;
    let log_warn_stub;
    let child_started_handler;
    let child_stopped_handler;
    let restart_handler;
    let restart_stub;

    before(() => {
        global.service = 'hdb_core';
        log_error_stub = sandbox.stub(harper_logger, 'error');
        log_info_stub = sandbox.stub(harper_logger, 'info');
        log_trace_stub = sandbox.stub(harper_logger, 'trace');
        log_warn_stub = sandbox.stub(harper_logger, 'warn');
        restart_stub = sandbox.stub(cluster_util, 'restartHDB');
        hdb_parent_ipc_handlers = rewire('../../../server/ipc/hdbParentIpcHandlers');
        child_started_handler = hdb_parent_ipc_handlers.__get__('childStartedHandler');
        child_stopped_handler = hdb_parent_ipc_handlers.__get__('childStoppedHandler');
        restart_handler = hdb_parent_ipc_handlers.__get__('restartHandler');
    });

    after(() => {
        sandbox.restore();
        rewire('../../../server/ipc/hdbParentIpcHandlers');
        delete global.service;
    });

    describe('Test childStartedHandler function', () => {
        const test_child_start_event = {
            "type": "child_started",
            "message": {
                "originator": 12345,
                "service": 'hdb_core'
            }
        };
        let kick_off_enterprise_stub;

        before(() => {
            kick_off_enterprise_stub = sandbox.stub(enterprise_util, 'kickOffEnterprise');
            global.forks = [12345];
            global.clustering_on = true;
        });

        afterEach(() => {
            sandbox.resetHistory();
        });

        after(() => {
            delete global.forks;
            delete global.clustering_on;
        });

        it('Test everything called as expected happy path', async () => {
            await child_started_handler(test_child_start_event);
            expect(kick_off_enterprise_stub).to.have.been.called;
            expect(log_info_stub.getCall(1).firstArg).to.equal("HDB server children initialized");
        });

        it('Test error from kickOffEnterprise is handled as expected', async () => {
            test_child_start_event.message.originator = 12333;
            global.forks = [12345, 12333];
            kick_off_enterprise_stub.throws(TEST_ERROR);
            await child_started_handler(test_child_start_event);
            expect(log_error_stub.args[0][0]).to.equal("HDB server children failed to start: I am a test error");
        });

        it('Test error logged if duplicate child started', async () => {
            await child_started_handler(test_child_start_event);
            expect(log_warn_stub.args[0][0]).to.equal("Got a duplicate child started event for pid 12333");
        });

        it('Test validation error is logged', async () => {
            delete test_child_start_event.type;
            await child_started_handler(test_child_start_event);
            expect(log_error_stub.args[0][0]).to.equal("IPC event missing 'type'");
        });
    });

    describe('Test childStoppedHandler function', () => {
        const emit_stub = sandbox.stub().callsFake(() => {});
        const children_stopped_event_fake = { emit: emit_stub };
        const test_child_stopped_event = {
            "type": "child_stopped",
            "message": {
                "originator": 12346,
                "service": 'hdb_core'
            }
        };
        let child_stop_rw;

        before(() => {
            hdb_parent_ipc_handlers.__set__('started_forks', {});
            child_stop_rw = hdb_parent_ipc_handlers.__set__('children_stopped_event.allChildrenStoppedEmitter', children_stopped_event_fake);
        });
        
        after(() => {
            child_stop_rw();
        });

        afterEach(() => {
            sandbox.resetHistory();
        });

        it('Test all children stopped event emitted', () => {
            child_stopped_handler(test_child_stopped_event);
            expect(emit_stub.args[0][0]).to.equal('all_children_stopped');
        });

        it('Test function does nothing if children still running', () => {
            hdb_parent_ipc_handlers.__set__('started_forks', { 75849: true});
            child_stopped_handler(test_child_stopped_event);
            expect(emit_stub).to.have.not.been.called;
        });

        it('Test error logged if duplicate received', () => {
            hdb_parent_ipc_handlers.__set__('started_forks', { 12346: false});
            child_stopped_handler(test_child_stopped_event);
            expect(log_warn_stub.args[0][0]).to.equal("Got a duplicate child stopped event for pid 12346");
        });

        it('Test validation error is logged', () => {
            test_child_stopped_event.message = {
                "service": 'hdb_core'
            };
            child_stopped_handler(test_child_stopped_event);
            expect(log_error_stub.args[0][0]).to.equal("IPC event message missing 'originator' property");
        });
    });

    describe('Test restartHandler function', () => {
        const close_server_stub = sandbox.stub().callsFake(() => {});
        const test_restart_event = {
            "type": "restart",
            "message": {
                "originator": 12346,
                "force": true
            }
        };

        before(() => {
            global.cluster_server = { closeServer: close_server_stub };
        });

        afterEach(() => {
            sandbox.resetHistory();
        });

        it('Test restartHDB is called on forced restart', () => {
            restart_handler(test_restart_event);
            expect(restart_stub).to.have.been.called;
            expect(log_info_stub.args[0][0]).to.equal("Force shutting down processes.");
        });

        it('Test closeServer is called on soft restart', () => {
            test_restart_event.message.force = false;
            restart_handler(test_restart_event);
            expect(close_server_stub).to.have.been.called;
        });

        it('Test validation error is logged', () => {
            test_restart_event.message = {};
            restart_handler(test_restart_event);
            expect(log_error_stub.args[0][0]).to.equal("IPC event message missing 'originator' property");
        });
    });
});