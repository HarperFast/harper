"use strict";
const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const DropUserRoom = require('../../../../server/socketcluster/room/DropUserRoom');
const WorkerStub = require('../worker/WorkerStub');
const RoomMessageObjects = require('../../../../server/socketcluster/room/RoomMessageObjects');

const WORKER_NAME = 'asdfesd';
const ADD_USER_TOPIC_NAME = 'AddUser';

const TEST_USER_DATA = {
    "role": {
        "id": "cf767e89-702a-4baf-b44c-e52544884889",
        "permission": {
            "cluster_user": true
        },
        "role": "cluster_user"
    },
    "username": "test7",
    "password": "tV2EZ0jUmd47f330d79fcfa7009a9768c7efbf77d",
    "active": true,
    "hash": "4c977a2f51798cf204f651ba3878b0ca471e223820ed871c85cdd9aa5795e6761f0ed8d04f22a340e8635b9d79d6b1999fa4ad3e8ffd63c52442b642208d2976"
};

describe('Test DropUserRoom inboundMsgHandler', function() {
    let test_instance = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    let publish_stub = undefined;
    let message_instance = undefined;
    beforeEach(() => {
        test_instance = new DropUserRoom(ADD_USER_TOPIC_NAME);
        worker_stub = new WorkerStub.WorkerStub();
        publish_stub = new sandbox.stub(test_instance, "publishToRoom").returns("");
        message_instance = new RoomMessageObjects.HdbCoreClusterDropUserRequestMessage();
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub = null;
        sandbox.restore();
    });

    it('Nominal test for inboundMsgHandler', async () => {
        message_instance.user = TEST_USER_DATA;
        worker_stub.hdb_users[TEST_USER_DATA.username] = TEST_USER_DATA;
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);

        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 0, 'Expected user to have 1 user');
        assert.strictEqual(worker_stub.exchange_set_called, true, 'Expected exchange set to be called.');
        assert.strictEqual(worker_stub.publish_called, true, 'Expected exchange set to be called.');
    });
    it('Test for inboundMsgHandler with invalid request', async () => {
        message_instance.user = null;
        worker_stub.hdb_users[TEST_USER_DATA.username] = TEST_USER_DATA;
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);

        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 1, 'Expected no user to be removed');
        assert.strictEqual(worker_stub.exchange_set_called, false, 'Expected exchange set to not be called.');
        assert.strictEqual(worker_stub.publish_called, false, 'Expected exchange set to not be called.');
    });
    it('Test for inboundMsgHandler with exchange set throwing exception, make sure exception quietly caught.', async () => {
        worker_stub.hdb_users[TEST_USER_DATA.username] = TEST_USER_DATA;
        worker_stub.exchange_set = (topic, data) => {
            throw new Error('This is bad');
        };
        message_instance.user = TEST_USER_DATA;
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);

        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 0, 'Expected no user to be left');
        assert.strictEqual(worker_stub.exchange_set_called, false, 'Expected exchange set to not be called.');
        assert.strictEqual(worker_stub.publish_called, false, 'Expected exchange set to not be called.');
    });
    it('Test for inboundMsgHandler with publish throwing exception, make sure exception quietly caught.', async () => {
        worker_stub.hdb_users[TEST_USER_DATA.username] = TEST_USER_DATA;
        worker_stub.exchange.publish = (topic, data) => {
            throw new Error('This is bad');
        };
        message_instance.user = TEST_USER_DATA;
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);

        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 0, 'Expected no user to be left');
        assert.strictEqual(worker_stub.exchange_set_called, true, 'Expected exchange set to not be called.');
        assert.strictEqual(worker_stub.publish_called, false, 'Expected exchange set to not be called.');
    });
    it('Test for inboundMsgHandler with specified user not found', async () => {
        worker_stub.hdb_users[TEST_USER_DATA.username] = TEST_USER_DATA;
        let user_copy = test_util.deepClone(TEST_USER_DATA);
        user_copy.password = 'Ive been changed';
        user_copy.username = 'not in here.';
        message_instance.user = user_copy;
        worker_stub.hdb_users[TEST_USER_DATA.username] = TEST_USER_DATA;
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);

        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 1, 'Expected no users to be removed');
        assert.strictEqual(worker_stub.hdb_users[TEST_USER_DATA.username].password, TEST_USER_DATA.password, 'Expected password not changed');
        assert.strictEqual(worker_stub.exchange_set_called, false, 'Expected exchange set to not be called.');
        assert.strictEqual(worker_stub.publish_called, false, 'Expected exchange set to not be called.');
    });
});