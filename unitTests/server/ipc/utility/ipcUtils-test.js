'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const hdb_logger = require('../../../../utility/logging/harper_logger');
const ipc_utils = require('../../../../server/ipc/utility/ipcUtils');

describe('Test ipcUtils module', () => {
    const sandbox = sinon.createSandbox();
    let log_warn_stub;

    before(() => {
        log_warn_stub = sandbox.stub(hdb_logger, 'warn');
    });

    after(() => {
        sandbox.restore();
    });

    describe('Test sendIpcEvent function', () => {
        it('Test emitToSever is called happy path', () => {
            const emit_to_server_stub = sandbox.stub().callsFake(() => {});
            global.hdb_ipc = { emitToServer: emit_to_server_stub };
            ipc_utils.sendIpcEvent({ type: 'restart', message: 1234 });
            expect(emit_to_server_stub.args[0][0]).to.eql({ type: 'restart', message: 1234 });
            delete global.hdb_ipc;
        });
        
        it('Test error is logged if global IPC client does not exist', () => {
            ipc_utils.sendIpcEvent({ type: 'restart', message: 1234 });
            const expected_log = "Tried to send event: {\"type\":\"restart\",\"message\":1234} to HDB IPC client but it does not exist";
            expect(log_warn_stub.args[0][0]).to.equal(expected_log);
        });
    });

    describe('Test validateEvent function', () => {
        it('Test non object error returned', () => {
            const result = ipc_utils.validateEvent('message');
            expect(result).to.equal('Invalid IPC event data type, must be an object');
        });

        it('Test missing type error returned', () => {
            const result = ipc_utils.validateEvent({message: 'add user'});
            expect(result).to.equal("IPC event missing 'type'");
        });

        it('Test missing message error returned', () => {
            const result = ipc_utils.validateEvent({type: 'schema'});
            expect(result).to.equal("IPC event missing 'message'");
        });

        it('Test invalid event type error returned', () => {
            const result = ipc_utils.validateEvent({ type: 'table', message: { "originator": 12345 } });
            expect(result).to.equal('IPC server received invalid event type: table');
        });

        it('Test missing originator error returned', () => {
            const result = ipc_utils.validateEvent({ type: 'table', message: { "operation": "create_table" } });
            expect(result).to.equal("IPC event message missing 'originator' property");
        });
    });

    describe('Test constructor functions', () => {
        it('Test SchemaEventMsg', () => {
            const expected_obj = {
                "attribute": undefined,
                "operation": "create_schema",
                "originator": 12345,
                "schema": "unit",
                "table": "test",
            };
            const result = new ipc_utils.SchemaEventMsg(12345, 'create_schema', 'unit', 'test');
            expect(result).to.eql(expected_obj);
        });

        it('Test UserEventMsg', () => {
            const expected_obj = {
                "originator": 12345
            };
            const result = new ipc_utils.UserEventMsg(12345);
            expect(result).to.eql(expected_obj);
        });

        it('Test ChildStartedMsg', () => {
            const expected_obj = {
                "originator": 12345
            };
            const result = new ipc_utils.ChildStartedMsg(12345);
            expect(result).to.eql(expected_obj);
        });

        it('Test ChildStoppedMsg', () => {
            const expected_obj = {
                "originator": 12345
            };
            const result = new ipc_utils.ChildStoppedMsg(12345);
            expect(result).to.eql(expected_obj);
        });

        it('Test RestartMsg', () => {
            const expected_obj = {
                "originator": 12345,
                "force": false
            };
            const result = new ipc_utils.RestartMsg(12345, false);
            expect(result).to.eql(expected_obj);
        });
    });
});