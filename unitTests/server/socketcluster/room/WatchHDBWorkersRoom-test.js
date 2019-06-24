"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const WatchHDBWorkersRoom = require('../../../../server/socketcluster/room/WatchHDBWorkersRoom');
const WorkerStub = require('../worker/WorkerStub');
const RoomMessageObjects = require('../../../../server/socketcluster/room/RoomMessageObjects');
const types = require('../../../../server/socketcluster/types');
const hdb_terms = require('../../../../utility/hdbTerms');

const WORKERS_MSG = ["SNHFXhrW5dAQ0edAAAAB"];

const GET_CLUSTER_STATUS_REQUEST = {
    "data": {
        "id": "7a783e3d-0a6d-4535-946b-f1511b0baed6",
        "type": "GET_CLUSTER_STATUS",
        "hdb_header": {},
        "requesting_hdb_worker_id": 29802,
        "requestor_channel": "qZuyjvAe_gr8TKV7AAAA",
        "__transacted": true
    },
    "timestamp": 1561147867000,
    "__originator": "qZuyjvAe_gr8TKV7AAAA",
    "schema": "qZuyjvAe_gr8TKV7AAAA"
};

const WORKER_CLUSTER_STATUS_MSG = {
        "type": "WORKER_ROOM_CLUSTER_STATUS",
        "request_id": "7f66b268-8011-47ef-b9ed-ea7a6ac7c42f",
        "worker_request_owner": 0,
        "__originator": 0
};

describe('Test UsersRoom inboundMsgHandler', function() {
    let test_instance = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    let message_instance = undefined;
    beforeEach(() => {
        test_instance = new WatchHDBWorkersRoom(hdb_terms.INTERNAL_SC_CHANNELS.HDB_USERS);
        worker_stub = new WorkerStub.WorkerStub();
        message_instance = new RoomMessageObjects.WatchHdbWorkersMessage();
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub = null;
        sandbox.restore();
    });

    it('Nominal test for inboundMsgHandler', async () => {
        message_instance.workers = WORKERS_MSG;
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);

        assert.strictEqual(worker_stub.hdb_workers.length, 2, 'Expected worker to have 2 workers');
    });
    it('test for inboundMsgHandler with invalid workers', async () => {
        message_instance.workers = {WORKERS_MSG};
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);

        assert.strictEqual(worker_stub.hdb_workers.length, 0, 'Expected worker to have 0 workers');
    });
});