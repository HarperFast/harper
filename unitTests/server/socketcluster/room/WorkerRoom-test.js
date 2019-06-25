"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const WorkerRoom = require('../../../../server/socketcluster/room/WorkerRoom');
const WorkerRoom_rw = rewire('../../../../server/socketcluster/room/WorkerRoom');
const types = require('../../../../server/socketcluster/types');
const WorkerStub = require('../worker/WorkerStub');
const socket_cluster_utils = require('../../../../server/socketcluster/util/socketClusterUtils');
const socket_cluster_status_event = require('../../../../events/SocketClusterStatusEmitter');
const RoomMessageObjects = require('../../../../server/socketcluster/room/RoomMessageObjects');

let SocketClusterStatusEmitter = "SocketClusterStatusEmitter";

const ROOM_NAME = 'hdb_internal:workers';

describe('Test CoreRoom evalRules', function() {
    let test_instance = undefined;
    let test_instance_rw = undefined;
    let matrix_stub = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    let publish_stub = undefined;
    let worker_status_stub = undefined;
    let request_message = undefined;
    let emitter_orig = undefined;
    let emitter_stub = undefined;
    let emitter_called = false;
    beforeEach(() => {
        test_instance = new WorkerRoom(ROOM_NAME);
        test_instance_rw = new WorkerRoom_rw(ROOM_NAME);
        worker_stub = new WorkerStub.WorkerStub();
        emitter_orig = WorkerRoom_rw.__get__('socket_cluster_status_event');
        emitter_stub = sandbox.stub(emitter_orig.socketClusterEmitter, 'emit').callsFake(() => {
            emitter_called = true;
        });
    });
    afterEach(() => {
        test_instance = undefined;
        test_instance_rw = undefined;
        worker_stub = null;
        matrix_stub = null;
        request_message = null;
        emitter_called = false;
        sandbox.restore();
    });

    it('Test nominal path of inboundMsgHandler with status request', async () => {
        request_message = new RoomMessageObjects.GetClusterStatusMessage();
        request_message.worker_request_owner = 11;
        let res = await test_instance.inboundMsgHandler(request_message, worker_stub, null);
        assert.strictEqual(worker_stub.publish_called, true, 'expected publish to be called');
   });

    it('Test nominal path of inboundMsgHandler with cluster status response', async () => {
        // Use the rewired version with a stubbed event emitter.

        request_message = new RoomMessageObjects.HdbCoreClusterStatusResponseMessage();
        request_message.worker_request_owner = 11;
        let res = await test_instance_rw.inboundMsgHandler(request_message, worker_stub, null);
        assert.strictEqual(emitter_called, true, 'expected emitter emit to be called');
    });
    it('Test nominal path of inboundMsgHandler with cluster status response, emitter throws', async () => {
        // Use the rewired version with a stubbed event emitter.
        emitter_stub.restore();
        emitter_stub = sandbox.stub(emitter_orig.socketClusterEmitter, 'emit').throws('This is bad');
        request_message = new RoomMessageObjects.HdbCoreClusterStatusResponseMessage();
        request_message.worker_request_owner = 11;
        let res = await test_instance_rw.inboundMsgHandler(request_message, worker_stub, null);
        assert.strictEqual(emitter_called, false, 'expected emitter emit to be called');
    });

    it('Test inboundMsgHandler with null message', async () => {
        request_message = null;
        let res = await test_instance.inboundMsgHandler(request_message, worker_stub, null);
        assert.strictEqual(worker_stub.publish_called, false, 'expected publish to be called');
    });

    it('Test inboundMsgHandler with workerid matching worker_request_owner', async () => {
        request_message = new RoomMessageObjects.GetClusterStatusMessage();
        request_message.worker_request_owner = 0;
        let res = test_instance.inboundMsgHandler(request_message, worker_stub, null);
        assert.strictEqual(worker_stub.publish_called, false, 'expected publish to be called');
    });
});