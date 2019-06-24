"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const UsersRoom = require('../../../../server/socketcluster/room/UsersRoom');
const WorkerStub = require('../worker/WorkerStub');
const RoomMessageObjects = require('../../../../server/socketcluster/room/RoomMessageObjects');
const types = require('../../../../server/socketcluster/types');
const hdb_terms = require('../../../../utility/hdbTerms');

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

const TEST_USERS = {
    "admin": {
        "active": true,
        "password": "gbLUxzTs8f39e03ee6f576e047381e3a5d102263e",
        "role": {
            "id": "ac865933-6a07-4164-a22c-937c0eafe207",
            "role": "super_user",
            "permission": {
                "super_user": true
            }
        },
        "username": "admin"
    },
    "cluster_user": {
        "active": true,
        "hash": "f3a43428950975f3fab7094b92897c312eb9fc8540a1035dca16ef08656f07fe1e487f2ce61e3e08c6a81f87d348341eef34a8d4522c956708a0bbe222eb7281",
        "password": "AqJuqvs8n35a5241a869c010ed4969604cf56ea95",
        "role": {
            "id": "cf767e89-702a-4baf-b44c-e52544884889",
            "role": "cluster_user",
            "permission": {
                "cluster_user": true
            }
        },
        "username": "cluster_user"
    },
    "test7": {
        "active": true,
        "hash": "4c977a2f51798cf204f651ba3878b0ca471e223820ed871c85cdd9aa5795e6761f0ed8d04f22a340e8635b9d79d6b1999fa4ad3e8ffd63c52442b642208d2976",
        "password": "tV2EZ0jUmd47f330d79fcfa7009a9768c7efbf77d",
        "role": {
            "id": "cf767e89-702a-4baf-b44c-e52544884889",
            "role": "cluster_user",
            "permission": {
                "cluster_user": true
            }
        },
        "username": "test7"
    },
    "test6": {
        "active": true,
        "hash": "ecbf43ee22c72cc70aa6d4c5dab389ba047b7e4c39b0f60bfadda010b05124eec4df0cb3687a48de0b8f82ef6f9d4e88a61190f28356d8d025087c071fb1ebd7",
        "password": "AAoXQtbIa0e5cf505cb3461ef8018de17d4729133",
        "role": {
            "id": "cf767e89-702a-4baf-b44c-e52544884889",
            "role": "cluster_user",
            "permission": {
                "cluster_user": true
            }
        },
        "username": "test6"
    }
};

describe('Test UsersRoom inboundMsgHandler', function() {
    let test_instance = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    let message_instance = undefined;
    beforeEach(() => {
        test_instance = new UsersRoom(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS);
        worker_stub = new WorkerStub.WorkerStub();
        message_instance = new RoomMessageObjects.SyncHdbUsersMessage();
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub = null;
        sandbox.restore();
    });

    it('Test Nominal case inboundMsgHandler',async () => {
        message_instance.data.users = TEST_USERS;
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);

        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 4, 'Expected worker to have 1 user');
    });
    it('Test inboundMsgHandler with invalid users',async () => {
        message_instance.data.users = null;
        worker_stub.hdb_users[TEST_USER_DATA.username] = TEST_USER_DATA;
        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 1, 'Expected worker to have 1 user');
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);

        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 1, 'Expected worker to have 1 user');
    });
    it('Test inboundMsgHandler with invalid user set',async () => {
        message_instance.data.users = [TEST_USER_DATA];
        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 0, 'Expected worker to have 1 user');
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);

        assert.strictEqual(Object.keys(worker_stub.hdb_users).length, 0, 'Expected worker to have 1 user');
    });
});

