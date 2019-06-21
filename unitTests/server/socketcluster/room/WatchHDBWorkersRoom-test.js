"use strict";

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const WatchHDBWorkersRoom = require('../../../../server/socketcluster/room/WatchHDBWorkersRoom');
const WorkerStub = require('../worker/WorkerStub');
const RoomMessageObjects = require('../../../../server/socketcluster/room/RoomMessageObjects');
const types = require('../../../../server/socketcluster/types');
const hdb_terms = require('../../../../utility/hdbTerms');

const WORKERS_MSG = ["SNHFXhrW5dAQ0edAAAAB"];

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
        message_instance.data.workers = WORKERS_MSG;
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);

        assert.strictEqual(worker_stub.hdb_workers.length, 2, 'Expected worker to have 2 workers');
    });
    it('test for inboundMsgHandler with invalid workers', async () => {
        message_instance.data.workers = {WORKERS_MSG};
        await test_instance.inboundMsgHandler(message_instance, worker_stub, null);

        assert.strictEqual(worker_stub.hdb_workers.length, 0, 'Expected worker to have 0 workers');
    });
});