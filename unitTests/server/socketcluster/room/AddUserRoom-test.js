"use strict";
const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const AddUserRoom = require('../../../../server/socketcluster/room/AddUserRoom');
const CoreRoom_rw = rewire('../../../../server/socketcluster/room/CoreRoom');
const types = require('../../../../server/socketcluster/types');
const RoomMessageObjects = require('../../../../server/socketcluster/room/RoomMessageObjects');
const WorkerStub = require('../worker/WorkerStub');

const WORKER_NAME = 'asdfesd';
const ADD_USER_TOPIC_NAME = 'AddUser';

const TEST_ROLE = {
    "id": "cf767e89-702a-4baf-b44c-e52544884889",
    "permission": {
        "cluster_user": true
    },
    "role": "cluster_user"
};

const TEST_USERNAME = "test4";
const TEST_PASSWORD = 'QLd0Ybb0L0b395da2bf01f8897ca94bf9d967c036asd23';
const ADD_USER_REQUEST = {
    "data": {
        "id": "bb50337c-3b7e-44a1-b3bc-ff676bdb4f13",
        "type": "ADD_USER",
        "hdb_header": {},
        "user": {
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
        },
        "__transacted": true
    },
    "timestamp": 1561135392784,
    "__originator": "Wp9gWwYSGiMGJ5WcAAAA"
};

class DecisionMatrixStub {
    evalRules(request, args, worker, connector_type_enum) {
        console.log('calling evalRules on decision matrix');
        return true;
    }
}

describe('Test CoreRoom evalRules', function() {
    let test_instance = undefined;
    let matrix_stub = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    let publish_stub = undefined;
    beforeEach(() => {
        test_instance = new AddUserRoom(ADD_USER_TOPIC_NAME);
        worker_stub = new WorkerStub.WorkerStub();
        matrix_stub = new DecisionMatrixStub();
        publish_stub = new sandbox.stub(test_instance, "publishToRoom").returns("");
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub = null;
        matrix_stub = null;
        sandbox.restore();
    });

    it('Nominal test for inboundMsgHandler', async () => {
        let request_copy = test_util.deepClone(ADD_USER_REQUEST);
        let response = await test_instance.inboundMsgHandler(request_copy, worker_stub, null);

        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 1, 'Expected worker to have 1 user');
        assert.strictEqual(worker_stub.exchange_set_called, true, 'Expected exchange set to be called.');
        assert.strictEqual(worker_stub.publish_called, true, 'Expected exchange set to be called.');
    });
    it('Test for inboundMsgHandler with invalid request', async () => {
        let request_copy = test_util.deepClone(ADD_USER_REQUEST);
        request_copy.data = null;
        let response = await test_instance.inboundMsgHandler(request_copy, worker_stub, null);

        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 0, 'Expected no workers to be added');
        assert.strictEqual(worker_stub.exchange_set_called, false, 'Expected exchange set to not be called.');
        assert.strictEqual(worker_stub.publish_called, false, 'Expected exchange set to not be called.');
    });
    it('Test for inboundMsgHandler with exchange set throwing exception, make sure exception quietly caught.', async () => {
        let request_copy = test_util.deepClone(ADD_USER_REQUEST);
        worker_stub.exchange_set = (topic, data) => {
          throw new Error('This is bad');
        };
        let response = await test_instance.inboundMsgHandler(request_copy, worker_stub, null);

        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 1, 'Expected no workers to be added');
        assert.strictEqual(worker_stub.exchange_set_called, false, 'Expected exchange set to not be called.');
        assert.strictEqual(worker_stub.publish_called, false, 'Expected exchange set to not be called.');
    });
    it('Test for inboundMsgHandler with publish throwing exception, make sure exception quietly caught.', async () => {
        let request_copy = test_util.deepClone(ADD_USER_REQUEST);
        worker_stub.exchange.publish = (topic, data) => {
            throw new Error('This is bad');
        };
        let response = await test_instance.inboundMsgHandler(request_copy, worker_stub, null);

        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 1, 'Expected no workers to be added');
        assert.strictEqual(worker_stub.exchange_set_called, true, 'Expected exchange set to not be called.');
        assert.strictEqual(worker_stub.publish_called, false, 'Expected exchange set to not be called.');
    });
});