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
});