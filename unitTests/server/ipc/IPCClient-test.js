'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
const test_util = require('../../test_utils');
const harper_logger = require('../../../utility/logging/harper_logger');
const IPCClient = require('../../../server/ipc/IPCClient');

describe('Test IPCClient class', () => {
    const sandbox = sinon.createSandbox();
    const event_handlers_test = {
        'add': () => {},
        'remove': () => {}
    };

    let client_test;
    let log_warn_stub;
    let log_trace_stub;

    before(() => {
        log_trace_stub = sandbox.stub(harper_logger, 'trace');
        log_warn_stub = sandbox.stub(harper_logger, 'warn');
    });

    after(() => {
        sandbox.restore();
    });

    afterEach(() => {
        client_test.ipc.disconnect('hdb_ipc_server');
    });
    
    it('Test client class is constructed as expected', () => {
        client_test = new IPCClient(123, event_handlers_test);
        expect(client_test.server_name).to.equal('hdb_ipc_server');
        expect(client_test.ipc.config.retry).to.equal(100);
        expect(client_test.ipc.config.id).to.equal('hdb_ipc_client_123');
        expect(typeof client_test.event_handlers.add).to.equal('function');
        expect(typeof client_test.event_handlers.remove).to.equal('function');
    });

    it('Test data is emitted to server', () => {
        client_test = new IPCClient(123, event_handlers_test);
        let error;
        try {
            client_test.emitToServer({ type: 'create_schema', message: 'dog'});
        } catch(err) {
            error = err;
        }

        expect(error).to.be.undefined;
        expect(log_trace_stub).to.have.been.calledWith('IPC client hdb_ipc_client_123 emitting {"type":"create_schema","message":"dog"}');
    });

    it('Test invalid IPC msg type is logged and thrown', () => {
        client_test = new IPCClient(123, event_handlers_test);
        test_util.assertErrorSync(client_test.emitToServer, ['delete all the data'], new Error('Invalid IPC message data type, must be an object'));
        expect(log_warn_stub).to.have.been.calledWith('Invalid IPC message data type, must be an object');
    });

    it('Test missing type is logged and thrown', () => {
        client_test = new IPCClient(123, event_handlers_test);
        test_util.assertErrorSync(client_test.emitToServer, [{ message: 'i am a message' }], new Error("IPC message missing 'type' property"));
        expect(log_warn_stub).to.have.been.calledWith("IPC message missing 'type' property");
    });

    it('Test missing message is logged and thrown', () => {
        client_test = new IPCClient(123, event_handlers_test);
        test_util.assertErrorSync(client_test.emitToServer, [{ type: 'create_table' }], new Error("IPC message missing 'message' property"));
        expect(log_warn_stub).to.have.been.calledWith("IPC message missing 'message' property");
    });

    it('Test invalid event type logged and thrown', () => {
        client_test = new IPCClient(123, event_handlers_test);
        let error;
        try {
            client_test.emitToServer({ type: 'delete_all', message: 'test me' })
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal("IPC server received invalid event type: delete_all");
        expect(log_warn_stub).to.have.been.calledWith("IPC server received invalid event type: delete_all");
    });
});