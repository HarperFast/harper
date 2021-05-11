'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
const rewire = require('rewire');
const test_util = require('../../test_utils');
const harper_logger = require('../../../utility/logging/harper_logger');

describe('Test ipcServer module', () => {
    const sandbox = sinon.createSandbox();
    let ipc_server;
    let ipc;
    let message_listener_rw;
    let log_warn_stub;
    let log_trace_stub;

    before(() => {
        test_util.preTestPrep();
        ipc_server = rewire('../../../server/ipc/ipcServer');
        ipc = ipc_server.__get__('ipc');
        message_listener_rw = ipc_server.__get__('messageListener');
        log_trace_stub = sandbox.stub(harper_logger, 'trace');
        log_warn_stub = sandbox.stub(harper_logger, 'warn');
    });

    after(() => {
        ipc.server.stop();
        ipc.disconnect('hdb_ipc_server');
        sandbox.restore();
    });

    it('Test IPC is initialized with correct config values', () => {
        expect(ipc.config.id).to.equal('hdb_ipc_server');
        expect(ipc.config.networkPort).to.equal(9383);
        expect(ipc.config.silent).to.equal(true);
        expect(ipc.config.retry).to.equal(100);
        expect(ipc.config.maxConnections).to.equal(1000);
    });

    it('Text messageListener function broadcasts message', () => {
        const broadcast_stub = sandbox.stub();
        ipc_server.__set__('ipc.server.broadcast', broadcast_stub);
        const data_test = { type: 'create_schema', message: 'unit-test' };
        message_listener_rw(data_test);

        expect(typeof broadcast_stub.args[0][1]).to.equal('object');
        expect(broadcast_stub.args[0][1].type).to.equal(data_test.type);
        expect(broadcast_stub.args[0][1].message).to.equal(data_test.message);
        expect(log_trace_stub).to.have.been.calledWith(`IPC server received a message type ${data_test.type}, with message ${data_test.message}`);
    });
    
    it('Test invalid IPC msg type is logged', () => {
        const data_test = 'create schema';
        message_listener_rw(data_test);
        expect(log_warn_stub).to.have.been.calledWith('Invalid IPC message type, must be an object');
    });

    it('Test missing type is logged', () => {
        const data_test = { message: 'unit-test' };
        message_listener_rw(data_test);
        expect(log_warn_stub).to.have.been.calledWith("IPC message missing 'type' property");
    });

    it('Test missing message is logged', () => {
        const data_test = { type: 'create_schema' };
        message_listener_rw(data_test);
        expect(log_warn_stub).to.have.been.calledWith("IPC message missing 'message' property");
    });

    it('Test invalid event type logged', () => {
        const data_test = { type: 'delete_db', message: 'unit-test' };
        message_listener_rw(data_test);
        expect(log_warn_stub).to.have.been.calledWith('IPC server received invalid event type: delete_db');
    });
});
