"use strict"

const { expect } = require('chai');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();

const RestartEventObject = require('../../server/RestartEventObject');
const harper_logger = require('../../utility/logging/harper_logger');

let logger_debug_stub;
const fake = () => {};


describe('Test RestartEventObject Class', () => {
    before(() => {
        logger_debug_stub = sandbox.stub(harper_logger, 'debug').callsFake(fake);
    })

    afterEach(() => {
        global.cluster_server = undefined;
        sandbox.resetHistory();
    })

    after(() => {
        sandbox.restore();
    })

    it('Constructor should generate a class instance with false values',() => {
        const test_result = new RestartEventObject();

        expect(test_result.sio_connections_stopped).to.be.false;
        expect(test_result.fastify_connections_stopped).to.be.false;
        expect(test_result.restart_in_progress).to.be.false;
    })

    it('isReadyForRestart() should return true if fastify connections closed and clustering off',() => {
        const test_obj = new RestartEventObject();
        test_obj.fastify_connections_stopped = true;

        const test_result = test_obj.isReadyForRestart();
        expect(test_result).to.be.true;
    })

    it('isReadyForRestart() should return false if fastify connections closed and clustering off BUT restart has already begun',() => {
        const test_obj = new RestartEventObject();
        test_obj.fastify_connections_stopped = true;
        test_obj.restart_in_progress = true;

        const test_result = test_obj.isReadyForRestart();
        expect(test_result).to.be.false;
    })

    it('isReadyForRestart() should return false if fastify and clustering connections closed and clustering off BUT restart has already begun',() => {
        const test_obj = new RestartEventObject();
        test_obj.fastify_connections_stopped = true;
        test_obj.sio_connections_stopped = true;
        test_obj.restart_in_progress = true;
        global.cluster_server = { server: "cluster server data" };

        const test_result = test_obj.isReadyForRestart();
        expect(test_result).to.be.false;
        delete global.cluster_server;
    })

    it('isReadyForRestart() should return false if fastify connections are still active',() => {
        const test_obj = new RestartEventObject();

        const test_result = test_obj.isReadyForRestart();
        expect(test_result).to.be.false;
    })

    it('isReadyForRestart() should return false if sio connections are still active',() => {
        const test_obj = new RestartEventObject();
        global.cluster_server = {};
        test_obj.fastify_connections_stopped = true;

        const test_result = test_obj.isReadyForRestart();
        expect(test_result).to.be.false;
        delete global.cluster_server;
    })

    it('isReadyForRestart() should log values tracked before returning true boolean',() => {
        const test_obj = new RestartEventObject();
        test_obj.fastify_connections_stopped = true;

        const test_result = test_obj.isReadyForRestart();

        expect(test_result).to.be.true;
        expect(logger_debug_stub.calledTwice).to.be.true;
        expect(logger_debug_stub.args[0][0]).to.be.eql('Server connections stopped: true');
        expect(logger_debug_stub.args[1][0]).to.be.eql('Fastify connections stopped: true');
    })

    it('isReadyForRestart() should log values tracked before returning false boolean',() => {
        const test_obj = new RestartEventObject();
        const test_result = test_obj.isReadyForRestart();

        expect(test_result).to.be.false;
        expect(logger_debug_stub.calledTwice).to.be.true;
        expect(logger_debug_stub.args[0][0]).to.be.eql('Server connections stopped: true');
        expect(logger_debug_stub.args[1][0]).to.be.eql('Fastify connections stopped: false');
    })
})
