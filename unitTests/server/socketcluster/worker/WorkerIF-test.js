"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const path = require('path');
const types = require('../../../../server/socketcluster/types');
/*
 "brokers": [
        "/var/folders/hv/64dqgv6n74q33ppww4fhl1_00000gn/T/socketcluster/socket_server_a98e85b442/b0"
    ],
 */
const RUN_OPTIONS = {
    "port": 12345,
    "workers": 0,
    "brokers": [
        "blahblahthisisfake/b0"
    ],
    "appName": "socket_server",
    "authPrivateKey": null,
    "authPublicKey": null,
    "authDefaultExpiry": 604800,
    "authAlgorithm": "HS256",
    "authVerifyAlgorithms": null,
    "authSignAsync": false,
    "authVerifyAsync": true,
    "crashWorkerOnError": true,
    "rebootWorkerOnCrash": true,
    "killWorkerMemoryThreshold": null,
    "protocol": "http",
    "protocolOptions": null,
    "logLevel": 2,
    "handshakeTimeout": 10000,
    "ackTimeout": 10000,
    "ipcAckTimeout": 10000,
    "pingInterval": 8000,
    "pingTimeout": 20000,
    "pingTimeoutDisabled": false,
    "origins": "*:*",
    "socketChannelLimit": 1000,
    "workerStatusInterval": 10000,
    "processTermTimeout": 10000,
    "forceKillTimeout": 15000,
    "forceKillSignal": "SIGHUP",
    "propagateErrors": true,
    "propagateWarnings": true,
    "middlewareEmitWarnings": false,
    "host": null,
    "tcpSynBacklog": null,
    "workerController": "/Users/elipalmer/harperdb/server/socketcluster/worker/ClusterWorker.js",
    "brokerController": "/Users/elipalmer/harperdb/server/socketcluster/broker.js",
    "brokerConnectRetryErrorThreshold": null,
    "workerClusterController": null,
    "rebootOnSignal": true,
    "downgradeToUser": false,
    "path": "/socketcluster/",
    "socketRoot": null,
    "schedulingPolicy": null,
    "allowClientPublish": true,
    "defaultWorkerDebugPort": 5858,
    "defaultBrokerDebugPort": 6858,
    "pubSubBatchDuration": null,
    "environment": "prod",
    "killMasterOnSignal": false,
    "wsEngine": "ws",
    "brokerEngine": "sc-broker-cluster",
    "connectTimeout": 10000,
    "sourcePort": 12345,
    "workerCount": 0,
    "brokerCount": 0,
    "id": 0
};

// Need to set these env variables for SCWorker.
process.env.workerInitOptions = JSON.stringify(RUN_OPTIONS);

const WorkerIF = require('../../../../server/socketcluster/worker/WorkerIF');
const CoreRoom = require('../../../../server/socketcluster/room/CoreRoom');
let test_instance = new WorkerIF();
const TEST_TOPIC = 'testTopic';

// Since we don't actually connect, we need to stub this.
process.send = (msg) => {
    return;
    //console.log('process.send is stubbed');
};

const ROOM_STUB = {
    topic: TEST_TOPIC
}

describe('Test workerIF', function() {
    let room_stub = undefined;
    let sandbox = sinon.createSandbox();
    before(() => {

    });
    beforeEach(() => {

        room_stub = sandbox.createStubInstance(CoreRoom);
        room_stub.topic=TEST_TOPIC;
    });
    afterEach(() => {
        test_instance.rooms = {};
        sandbox.restore();

    });

    it('Test WorkerIF addRoom', () => {
        let result = null;
        try {
            result = test_instance.addRoom(room_stub);
        } catch(err) {
            result = err;
        }
        assert.equal(Object.keys(test_instance.rooms).length, 1, 'expected room to be added');
    });
    it('Test WorkerIF addRoom with empty room, expect exception', () => {
        let result = null;
        try {
            result = test_instance.addRoom(null);
        } catch(err) {
            result = err;
        }
        assert.equal(result instanceof Error, true,'excpected exception');
        assert.equal(Object.keys(test_instance.rooms).length, 0, 'expected room not to be added');
    });
    it('Test WorkerIF addRoom with room with empty topic', () => {
        room_stub.topic = null;
        let result = null;
        try {
            result = test_instance.addRoom(room_stub);
        } catch(err) {
            result = err;
        }
        assert.equal(result instanceof Error, true,'excpected exception');
        assert.equal(Object.keys(test_instance.rooms).length, 0, 'expected room not to be added');
    });
    it('Test WorkerIF addRoom with room with duplicate topic', () => {
        let result = null;
        try {
            result = test_instance.addRoom(room_stub);
            test_instance.addRoom(room_stub);
        } catch(err) {
            result = err;
        }
        assert.equal(result instanceof Error, true,'excpected exception');
        assert.equal(Object.keys(test_instance.rooms).length, 1, 'expected 1 room to be added');
    });
});


describe('Test workerIF', function() {
    let room_stub = undefined;
    let sandbox = sinon.createSandbox();
    before(() => {

    });
    beforeEach(() => {
        room_stub = sandbox.createStubInstance(CoreRoom);
        room_stub.topic = TEST_TOPIC;
    });
    afterEach(() => {
        test_instance.rooms = {};
        sandbox.restore();
    });

    it('Test WorkerIF getRoom', () => {
        let result = null;
        test_instance.addRoom(room_stub);
        result = test_instance.getRoom(room_stub.topic);
        assert.notEqual(result, undefined, 'expected room to be found');
    });
    it('Test WorkerIF getRoom on nonexistent room', () => {
        let result = null;
        test_instance.addRoom(room_stub);
        result = test_instance.getRoom('bad topic');
        assert.equal(null, null, 'expected room to not be found');
    });
});

describe('Test workerIF evalRoomMiddleware', function() {
    let room_stub = undefined;
    let sandbox = sinon.createSandbox();
    let eval_stub = undefined;
    let get_room_stub = undefined;
    before(() => {

    });
    beforeEach(() => {
        room_stub = sandbox.createStubInstance(CoreRoom);
        room_stub.topic = TEST_TOPIC;
    });
    afterEach(() => {
        test_instance.rooms = {};
        sandbox.restore();
    });

    it('nominal evalMiddleware', async () => {
        get_room_stub = sandbox.stub(test_instance, 'getRoom').returns(room_stub);
        room_stub.evalMiddleware = () => {};
        eval_stub = sandbox.stub(room_stub, 'evalMiddleware').resolves(true);
        let result = await test_instance.evalRoomMiddleware({}, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);

        assert.equal(result, true, 'expected success');
    });
    it('evalMiddleware no room found', async () => {
        get_room_stub = sandbox.stub(test_instance, 'getRoom').returns(null);
        room_stub.evalMiddleware = () => {};
        eval_stub = sandbox.stub(room_stub, 'evalMiddleware').resolves(true);
        let result = await test_instance.evalRoomMiddleware({}, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);

        assert.equal(result, types.ERROR_CODES.MIDDLEWARE_ERROR, 'expected success');
    });
    it('evalMiddleware with failure', async () => {
        get_room_stub = sandbox.stub(test_instance, 'getRoom').returns(room_stub);
        room_stub.evalMiddleware = () => {};
        eval_stub = sandbox.stub(room_stub, 'evalMiddleware').resolves(false);
        let result = await test_instance.evalRoomMiddleware({}, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);

        assert.equal(result, false, 'expected success');
    });
});

describe('Test workerIF evalRoomPublishInMiddleware', function() {
    let room_stub = undefined;
    let sandbox = sinon.createSandbox();
    let eval_stub = undefined;
    let next_stub = undefined;
    before(() => {

    });
    beforeEach(() => {
        room_stub = sandbox.createStubInstance(CoreRoom);
        room_stub.topic = TEST_TOPIC;
    });
    afterEach(() => {
        test_instance.rooms = {};
        sandbox.restore();
    });

    it('nominal evalRoomPublishInMiddleware', async () => {
        eval_stub = sandbox.stub(test_instance, 'evalRoomMiddleware').returns();
        next_stub = sandbox.stub().returns();
        let result = await test_instance.evalRoomPublishInMiddleware({}, next_stub);

        assert.equal(result, undefined, 'expected success');
        assert.equal(next_stub.calledOnce, true, 'expected stub not to be called');
    });
    it('evalRoomPublishInMiddleware middleware failure', async () => {
        eval_stub = sandbox.stub(test_instance, 'evalRoomMiddleware').returns(types.ERROR_CODES.MIDDLEWARE_ERROR);
        next_stub = sandbox.stub().returns();
        let result = await test_instance.evalRoomPublishInMiddleware({}, next_stub);

        assert.equal(result, undefined, 'expected success');
        assert.equal(next_stub.calledOnce, true, 'expected stub to be called');
        assert.equal(next_stub.calledWith(`Message was swallowed in PublishIn middleware. ${types.ERROR_CODES.MIDDLEWARE_ERROR}`), true, 'expected next to be called with error');
    });
});

describe('Test workerIF evalRoomPublishOutMiddleware', function() {
    let room_stub = undefined;
    let sandbox = sinon.createSandbox();
    let eval_stub = undefined;
    let next_stub = undefined;
    before(() => {

    });
    beforeEach(() => {
        room_stub = sandbox.createStubInstance(CoreRoom);
        room_stub.topic = TEST_TOPIC;
    });
    afterEach(() => {
        test_instance.rooms = {};
        sandbox.restore();
    });

    it('nominal evalRoomPublishOutMiddleware', async () => {
        eval_stub = sandbox.stub(test_instance, 'evalRoomMiddleware').returns();
        next_stub = sandbox.stub().returns();
        let result = await test_instance.evalRoomPublishOutMiddleware({}, next_stub);

        assert.equal(result, undefined, 'expected success');
        assert.equal(next_stub.calledOnce, true, 'expected stub not to be called');
    });
    it('evalRoomPublishInMiddleware middleware failure', async () => {
        eval_stub = sandbox.stub(test_instance, 'evalRoomMiddleware').returns(types.ERROR_CODES.MIDDLEWARE_ERROR);
        next_stub = sandbox.stub().returns();
        let result = await test_instance.evalRoomPublishOutMiddleware({}, next_stub);

        assert.equal(result, undefined, 'expected success');
        assert.equal(next_stub.calledOnce, true, 'expected stub to be called');
        assert.equal(next_stub.calledWith(`Message was swallowed in PublishOut middleware. ${types.ERROR_CODES.MIDDLEWARE_ERROR}`), true, 'expected next to be called with error');
    });
});

describe('Test workerIF evalRoomSubscribeMiddleware', function() {
    let room_stub = undefined;
    let sandbox = sinon.createSandbox();
    let eval_stub = undefined;
    let next_stub = undefined;
    before(() => {

    });
    beforeEach(() => {
        room_stub = sandbox.createStubInstance(CoreRoom);
        room_stub.topic = TEST_TOPIC;
    });
    afterEach(() => {
        test_instance.rooms = {};
        sandbox.restore();
    });

    it('nominal evalRoomSubscribeMiddleware', async () => {
        eval_stub = sandbox.stub(test_instance, 'evalRoomMiddleware').returns();
        next_stub = sandbox.stub().returns();
        let result = await test_instance.evalRoomSubscribeMiddleware({}, next_stub);

        assert.equal(result, undefined, 'expected success');
        assert.equal(next_stub.calledOnce, true, 'expected stub not to be called');
    });
    it('evalRoomSubscribeMiddleware middleware failure', async () => {
        eval_stub = sandbox.stub(test_instance, 'evalRoomMiddleware').returns(types.ERROR_CODES.MIDDLEWARE_ERROR);
        next_stub = sandbox.stub().returns();
        let result = await test_instance.evalRoomSubscribeMiddleware({}, next_stub);

        assert.equal(result, undefined, 'expected success');
        assert.equal(next_stub.calledOnce, true, 'expected stub to be called');
        assert.equal(next_stub.calledWith(`Message was swallowed in Subscribe middleware. ${types.ERROR_CODES.MIDDLEWARE_ERROR}`), true, 'expected next to be called with error');
    });
});

describe('Test workerIF evalRoomAuthenticateMiddleware', function() {
    let room_stub = undefined;
    let sandbox = sinon.createSandbox();
    let eval_stub = undefined;
    let next_stub = undefined;
    before(() => {

    });
    beforeEach(() => {
        room_stub = sandbox.createStubInstance(CoreRoom);
        room_stub.topic = TEST_TOPIC;
    });
    afterEach(() => {
        test_instance.rooms = {};
        sandbox.restore();
    });

    it('nominal evalRoomAuthenticateMiddleware', async () => {
        eval_stub = sandbox.stub(test_instance, 'evalRoomMiddleware').returns();
        next_stub = sandbox.stub().returns();
        let result = await test_instance.evalRoomAuthenticateMiddleware({}, next_stub);

        assert.equal(result, undefined, 'expected success');
        assert.equal(next_stub.calledOnce, true, 'expected stub not to be called');
    });
    it('evalRoomAuthenticateMiddleware middleware failure', async () => {
        eval_stub = sandbox.stub(test_instance, 'evalRoomMiddleware').returns(types.ERROR_CODES.MIDDLEWARE_ERROR);
        next_stub = sandbox.stub().returns();
        let result = await test_instance.evalRoomAuthenticateMiddleware({}, next_stub);

        assert.equal(result, undefined, 'expected success');
        assert.equal(next_stub.calledOnce, true, 'expected stub to be called');
        assert.equal(next_stub.calledWith(`Message was swallowed in Authenticate middleware. ${types.ERROR_CODES.MIDDLEWARE_ERROR}`), true, 'expected next to be called with error');
    });
});
