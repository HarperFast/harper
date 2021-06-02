'use strict';

const chai = require('chai');
const sinon = require('sinon');
const rewire = require('rewire');
const { expect } = chai;
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
let test_utils;
let ipc_utils;
let hdb_logger;
let signalling;

describe('Test signalling module', () => {
    const sandbox = sinon.createSandbox();
    const TEST_ERROR = 'oh no an error';
    let send_ipc_event_stub;
    let log_error_stub;

    before(() => {
        hdb_logger = require('../../utility/logging/harper_logger');
        log_error_stub = sandbox.stub(hdb_logger, 'error');
        sandbox.stub(hdb_logger, 'trace');
        test_utils = require('../test_utils');
        ipc_utils = require('../../server/ipc/utility/ipcUtils');
        send_ipc_event_stub = sandbox.stub(ipc_utils, 'sendIpcEvent');
        signalling = rewire('../../utility/signalling');
    });

    afterEach(() => {
        send_ipc_event_stub.returns();
        sandbox.resetHistory();
    });

    after(() => {
        sandbox.restore();
        rewire('../../utility/signalling');
    });

    it('Test signalSchemaChange happy path', () => {
        const message = {
            "operation":"create_schema",
            "schema": "unit_test"
        };
        const expected_event = {
            "type": "schema",
            "message": {
                "operation": "create_schema",
                "schema": "unit_test"
            }
        };
        signalling.signalSchemaChange(message);
        expect(send_ipc_event_stub).to.have.been.calledWith(sinon.match(expected_event));
    });

    it('Test signalSchemaChange sad path', () => {
        send_ipc_event_stub.throws(TEST_ERROR);
        signalling.signalSchemaChange('message');
        expect(log_error_stub.args[0][0].name).to.equal(TEST_ERROR);
    });

    it('Test signalUserChange happy path', () => {
        const message = 'user';
        const expected_event = {
            "type": "user",
            "message": 'user'
        };
        signalling.signalUserChange(message);
        expect(send_ipc_event_stub).to.have.been.calledWith(sinon.match(expected_event));
    });

    it('Test signalUserChange sad path', () => {
        send_ipc_event_stub.throws(TEST_ERROR);
        signalling.signalUserChange('message');
        expect(log_error_stub.args[0][0].name).to.equal(TEST_ERROR);
    });

    it('Test signalChildStarted happy path', () => {
        signalling.signalChildStarted();
        expect(send_ipc_event_stub.args[0][0].type).to.equal('child_started');
        expect(send_ipc_event_stub.args[0][0]).to.haveOwnProperty('message');
    });

    it('Test signalChildStarted sad path', () => {
        send_ipc_event_stub.throws(TEST_ERROR);
        signalling.signalChildStarted('message');
        expect(log_error_stub.args[0][0].name).to.equal(TEST_ERROR);
    });

    it('Test signalChildStopped happy path', () => {
        signalling.signalChildStopped();
        expect(send_ipc_event_stub.args[0][0].type).to.equal('child_stopped');
        expect(send_ipc_event_stub.args[0][0]).to.haveOwnProperty('message');
    });

    it('Test signalChildStopped sad path', () => {
        send_ipc_event_stub.throws(TEST_ERROR);
        signalling.signalChildStopped('message');
        expect(log_error_stub.args[0][0].name).to.equal(TEST_ERROR);
    });

    it('Test signalRestart happy path', () => {
        const message = { "force": true };
        const expected_event = {
            "type": "restart",
            "message": { force:true }
        };
        signalling.signalRestart(message);
        expect(send_ipc_event_stub).to.have.been.calledWith(sinon.match(expected_event));
    });

    it('Test signalRestart sad path', () => {
        send_ipc_event_stub.throws(TEST_ERROR);
        const message = { "force": true };
        signalling.signalRestart(message);
        expect(log_error_stub.args[0][0].name).to.equal(TEST_ERROR);
    });

    it('Test signalRestart error thrown if value not boolean', () => {
        test_utils.assertErrorSync(signalling.signalRestart, ['yes'], new Error('Invalid force value, must be a boolean.'));
        expect(log_error_stub.args[0][0]).to.equal('Invalid force value, must be a boolean.');
    });
});