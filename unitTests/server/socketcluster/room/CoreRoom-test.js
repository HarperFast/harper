"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const CoreRoom = require('../../../../server/socketcluster/room/CoreRoom');
const CoreRoom_rw = rewire('../../../../server/socketcluster/room/CoreRoom');
const types = require('../../../../server/socketcluster/types');
const socket_cluster_utils = require('../../../../server/socketcluster/util/socketClusterUtils');
const socket_cluster_status_event = require('../../../../events/SocketClusterStatusEmitter');
const RoomMessageObjects = require('../../../../server/socketcluster/room/RoomMessageObjects');

const ROOM_NAME = 'dev.tester';
const WORKER_NAME = 'asdfesd';
const SET_TIMEOUT_TIME_MS = 1000;

class WorkerStub {
    constructor() {
        this['exchange'] = {};
        this.publish_called = false;
        this.exchange.publish = (channel, req) => {
            console.log('Called publish');
            this.publish_called = true;
        };
        this.id = WORKER_NAME;
        this.hdb_workers = [WORKER_NAME];
        this.scServer = {
            clients: {
                "ASDLKFJSDFLAKD": {
                    id: 'testid',
                    remoteAddress: 'outside',
                    remotePort: '33333',
                    state: 'connected',
                    exchange: {
                        _channels: {
                            "dev:dog": {
                                name: 'dev:dog',
                                state: 'subscribed'
                            },
                            "dev:breed": {
                                name: 'dev:dog',
                                state: 'subscribed'
                            },
                            "hdb_internal:create_schema": {
                                name: 'dev:dog',
                                state: 'subscribed'
                            }
                        }
                    }
                }
            }
        };
        this.node_connector = {
            connections: {
                clients: {
                    "https://localhost:12345/socketcluster": {
                        options: {
                            hostname: 'Im a test',
                            post: '12345',
                            state: 'connected'
                        },
                        additional_info: {
                            subscriptions: {
                                "name": "truck_1",
                                "subscriptions": [
                                    {
                                        "channel": "dev:dog",
                                        "publish": true,
                                        "subscribe": true
                                    },
                                    {
                                        "channel": "dev:breed",
                                        "publish": false,
                                        "subscribe": true
                                    },
                                    {
                                        "channel": "hdb_internal:create_schema",
                                        "publish": true,
                                        "subscribe": true
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        };
    }
};

class DecisionMatrixStub {
    evalRules(request, args, worker, connector_type_enum) {
        console.log('calling evalRules on decision matrix');
        return true;
    }
}

const TEST_REQUEST = {
    channel: ROOM_NAME,
    data: {},
    hdb_header: {},
    socket: {}
};

const GET_WORKER_STATUS_INPUT = {
    "data": {
        "type": "CLUSTER_STATUS_RESPONSE",
        "outbound_connections": [],
        "inbound_connections": [],
        "hdb_header": {}
    }
};

const CLUSTER_STATUS_RESPONSE_MSG = {
        "type": "CLUSTER_STATUS_RESPONSE",
        "outbound_connections": [
            {
                "id": "",
                "host_address": "10.211.55.3",
                "host_port": 12345,
                "state": "closed",
                "node_name": "truck_1",
                "subscriptions": [
                    {
                        "channel": "dev:dog",
                        "publish": true,
                        "subscribe": true
                    },
                    {
                        "channel": "dev:breed",
                        "publish": false,
                        "subscribe": true
                    }
                ]
            }
        ],
        "inbound_connections": [
            {
                "id": "5aWRB1SazNokMXKmAAAA",
                "host_address": "::ffff:127.0.0.1",
                "host_port": 61254,
                "state": "open",
                "subscriptions": [
                    {
                        "channel": "dev:dog",
                        "state": "subscribed"
                    },
                    {
                        "channel": "5aWRB1SazNokMXKmAAAA",
                        "state": "subscribed"
                    }
                ]
            },
            {
                "id": "Azql9I2Nlzo-Xb3uAAAB",
                "host_address": "::ffff:127.0.0.1",
                "host_port": 61255,
                "state": "open",
                "subscriptions": [
                    {
                        "channel": "dev:dog",
                        "state": "subscribed"
                    },
                    {
                        "channel": "5aWRB1SazNokMXKmAAAA",
                        "state": "subscribed"
                    }
                ]
            }
        ],
        "hdb_header": {}
};

const INBOUND_MSG_HANDLER_TEST_MSG = {
        "type": "GET_CLUSTER_STATUS",
        "requesting_hdb_worker_id": 24064,
        "requestor_channel": "5aWRB1SazNokMXKmAAAA",
        "hdb_header": {},
    "timestamp": 1561055789296,
    "__originator": "5aWRB1SazNokMXKmAAAA"
};

const GET_WORKER_STATUS_EXPECTED_RESPONSE = {
        "type": "CLUSTER_STATUS_RESPONSE",
        "outbound_connections": [
            {
                "id": "",
                "host_address": "10.211.55.3",
                "host_port": 12345,
                "state": "closed",
                "node_name": "truck_1",
                "subscriptions": [
                    {
                        "channel": "dev:dog",
                        "publish": true,
                        "subscribe": true
                    },
                    {
                        "channel": "dev:breed",
                        "publish": false,
                        "subscribe": true
                    }
                ]
            }
        ],
        "inbound_connections": [
            {
                "id": "BG4FN1TjwxU3wKMRAAAE",
                "host_address": "::ffff:127.0.0.1",
                "host_port": 61283,
                "state": "open",
                "subscriptions": [
                    {
                        "channel": "dev:dog",
                        "state": "subscribed"
                    },
                    {
                        "channel": "5aWRB1SazNokMXKmAAAA",
                        "state": "subscribed"
                    },
                    {
                        "channel": "_qmcFuUAZsqPMbnhAAAC",
                        "state": "subscribed"
                    },
                    {
                        "channel": "BG4FN1TjwxU3wKMRAAAE",
                        "state": "subscribed"
                    }
                ]
            }
        ],
        "hdb_header": {}
};

const PROMISE_RESPONSE_MSG = {
    "hdb_header": {},
    "type": "CLUSTER_STATUS_RESPONSE",
    "is_enabled": true,
        "outbound_connections": [
            {
                "id": "",
                "host_address": "THIS IS CRAP",
                "host_port": 16666,
                "state": "WHAT STATE?",
                "node_name": "SOME_TRUCK",
                "subscriptions": [
                    {
                        "channel": "dev:kittywitty",
                        "publish": true,
                        "subscribe": true
                    },
                    {
                        "channel": "dev:birdy",
                        "publish": false,
                        "subscribe": true
                    }
                ]
            }
        ],
        "inbound_connections": [
            {
                "id": "WG44es8-kxiDJRmIAAAA",
                "host_address": "WTH is this?",
                "host_port": 56512,
                "state": "open",
                "subscriptions": [
                    {
                        "channel": "dev:dammitbobby",
                        "state": "NOT subscribed."
                    }
                ]
            }
        ]
};

function buildWorkerStatusMessage() {
    let worker_status_msg = new RoomMessageObjects.WorkerStatusMessage();
    worker_status_msg.hdb_header =  {};
    worker_status_msg.type = "CLUSTER_STATUS_RESPONSE";
    worker_status_msg.is_enabled = true;
    worker_status_msg.inbound_connections = [
        {
            "id": "WG44es8-kxiDJRmIAAAA",
            "host_address": "WTH is this?",
            "host_port": 56512,
            "state": "open",
            "subscriptions": [
                {
                    "channel": "dev:dammitbobby",
                    "state": "NOT subscribed."
                }
            ]
        }
    ];
    worker_status_msg.outbound_connections = [
        {
            "id": "",
            "host_address": "THIS IS CRAP",
            "host_port": 16666,
            "state": "WHAT STATE?",
            "node_name": "SOME_TRUCK",
            "subscriptions": [
                {
                    "channel": "dev:kittywitty",
                    "publish": true,
                    "subscribe": true
                },
                {
                    "channel": "dev:birdy",
                    "publish": false,
                    "subscribe": true
                }
            ]
        }
    ];
    return worker_status_msg;
}

describe('Test CoreRoom evalRules', function() {
    let test_instance = undefined;
    let matrix_stub = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    let publish_stub = undefined;
    let worker_status_stub = undefined;
    beforeEach(() => {
        test_instance = new CoreRoom(ROOM_NAME);
        worker_stub = new WorkerStub();
        matrix_stub = new DecisionMatrixStub();
        publish_stub = new sandbox.stub(test_instance, "publishToRoom").returns("");
        worker_status_stub = new sandbox.stub(socket_cluster_utils, 'getWorkerStatus').returns(GET_WORKER_STATUS_EXPECTED_RESPONSE);
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub = null;
        matrix_stub = null;
        sandbox.restore();
    });

    it('test constructor', () => {
        assert.equal(test_instance.topic, ROOM_NAME, 'expected topic to be same as parameter.');
    });

    it('test evalRules with no decision matrix', async () => {
        let result = undefined;
        try {
            result = await test_instance.evalRules(TEST_REQUEST, worker_stub, {}, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal(result, true, 'expected success.');
    });

    it('test evalRules with eval failure', async () => {
        let result = undefined;
        matrix_stub.evalRules = async (request, args, worker, connector_type_enum) => {
            return false;
        };
        test_instance.setDecisionMatrix(matrix_stub);
        try {
            result = await test_instance.evalRules(TEST_REQUEST, worker_stub, {}, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal(result, false, 'expected success.');
    });
    it('test evalRules with eval exception', async () => {
        let result = undefined;
        matrix_stub.evalRules = async (request, args, worker, connector_type_enum) => {
            throw new Error('Rule failure');
        };
        test_instance.setDecisionMatrix(matrix_stub);
        try {
            result = await test_instance.evalRules(TEST_REQUEST, worker_stub, {}, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal(result, false, 'expected success.');
    });
});

describe('Test CoreRoom inboundMsgHandler', function() {
    let test_instance = undefined;
    let matrix_stub = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    let publish_stub = undefined;
    let worker_status_stub = undefined;
    beforeEach(() => {
        test_instance = new CoreRoom(ROOM_NAME);
        worker_stub = new WorkerStub();
        matrix_stub = new DecisionMatrixStub();
        publish_stub = new sandbox.stub(test_instance, "publishToRoom").returns('');
        worker_status_stub = new sandbox.stub(socket_cluster_utils, 'getWorkerStatus').returns(GET_WORKER_STATUS_EXPECTED_RESPONSE);
    });
    afterEach(() => {
        test_instance = null;
        worker_stub = null;
        matrix_stub = null;
        sandbox.restore();
    });
    it('test inboundMsgHandler nominal path, 1 worker', async () => {
        let request_copy = test_util.deepClone(TEST_REQUEST);
        let response = await test_instance.inboundMsgHandler(INBOUND_MSG_HANDLER_TEST_MSG, worker_stub, null);
        assert.strictEqual(publish_stub.called, true, 'Expected publish to be called');
        assert.strictEqual(worker_status_stub.called, true, 'Expected publish to be called');
    });
    it('test inboundMsgHandler nominal path, 2 workers', async () => {
        let worker_status_msg = buildWorkerStatusMessage();
        worker_stub.hdb_workers.push('AnotherWorker');
        // Simulate another worker sending a message through the worker room.
        setTimeout(() => {
            socket_cluster_status_event.socketClusterEmitter.emit(socket_cluster_status_event.EVENT_NAME, worker_status_msg);
        }, SET_TIMEOUT_TIME_MS);

        // Use the publish stub to set the response message id.  The response messages cluster_status_request_id would normally
        // be set to the original messages id.
        worker_stub.exchange.publish = (hdbChild, req) => {
            worker_status_msg.cluster_status_request_id = req.request_id;
            console.log('Called publish');
        };

        let response = await test_instance.inboundMsgHandler(INBOUND_MSG_HANDLER_TEST_MSG, worker_stub, null);
        assert.strictEqual(publish_stub.called, true, 'Expected publish to be called');
        assert.strictEqual(worker_status_stub.called, true, 'Expected publish to be called');
        assert.strictEqual(response.inbound_connections.length, 1, 'Expected publish to be called');
        assert.strictEqual(response.outbound_connections.length, 1, 'Expected publish to be called');
    });
    it('test inboundMsgHandler with unrecognized type', async () => {
        let response = await test_instance.inboundMsgHandler(INBOUND_MSG_HANDLER_TEST_MSG, worker_stub, null);
        assert.strictEqual(null, null, 'Expected publish to be called');
    });
    it('test inboundMsgHandler getWorkerStatus throws exception', async () => {
        worker_status_stub.restore();
        worker_status_stub = new sinon.stub(socket_cluster_utils, 'getWorkerStatus').throws(new Error('This is bad.'));
        let response = await test_instance.inboundMsgHandler(INBOUND_MSG_HANDLER_TEST_MSG, worker_stub, null);
        assert.notStrictEqual(response.error.length, 0, 'Expected error message in response');
        assert.strictEqual(response.inbound_connections.length, 0, 'Expected inbound connections to be reset');
        assert.strictEqual(response.outbound_connections.length, 0, 'Expected outbound connections to be reset');
    });
    it('test inboundMsgHandler publish to room throws exception', async () => {
        publish_stub.restore();
        publish_stub = publish_stub = new sinon.stub(test_instance, "publishToRoom").throws(new Error('This is bad.'));
        let response = await test_instance.inboundMsgHandler(INBOUND_MSG_HANDLER_TEST_MSG, worker_stub, null);
        assert.notStrictEqual(response, null, 'Expected no response');
    });
    it('test inboundMsgHandler invalid request', async () => {
        let response = await test_instance.inboundMsgHandler(null, worker_stub, null);
        assert.notStrictEqual(response, null, 'Expected no response');
    });
    it('test inboundMsgHandler with 2 workers, second worker will timeout.', async () => {
        worker_stub.hdb_workers.push('AnotherWorker');
        let timeout_orig = CoreRoom_rw.__get__('STATUS_TIMEOUT_MS');
        // Lower timeout so this test doesn't slow everything down.
        CoreRoom_rw.__set__('STATUS_TIMEOUT_MS', SET_TIMEOUT_TIME_MS);
        test_instance = new CoreRoom_rw();
        let response = await test_instance.inboundMsgHandler(INBOUND_MSG_HANDLER_TEST_MSG, worker_stub, null);
        assert.notStrictEqual(response.error.length, 0, 'Expected error message in response');
        assert.strictEqual(response.inbound_connections.length, 0, 'Expected inbound connections to be reset');
        assert.strictEqual(response.outbound_connections.length, 0, 'Expected outbound connections to be reset');
        CoreRoom_rw.__set__('STATUS_TIMEOUT_MS', timeout_orig);
    });
});

describe('Test CoreRoom addStatusResponseValues', function() {
    let sandbox = sinon.createSandbox();
    let addStatusResponseValues = CoreRoom_rw.__get__('addStatusResponseValues');
    beforeEach(() => {
    });
    afterEach(() => {
        sandbox.restore();
    });
    it('test addStatusResponseValues nominal case', () => {
        let worker_status_msg = buildWorkerStatusMessage();
        let cluster_status_response = new RoomMessageObjects.HdbCoreClusterStatusResponseMessage();
        addStatusResponseValues(cluster_status_response, worker_status_msg);
        assert.strictEqual(cluster_status_response.inbound_connections.length, 1, 'Expected publish to be called');
        assert.strictEqual(cluster_status_response.outbound_connections.length, 1, 'Expected publish to be called');
    });
    it('test addStatusResponseValues null status input', () => {
        let worker_status_msg = buildWorkerStatusMessage();
        let cluster_status_response = new RoomMessageObjects.HdbCoreClusterStatusResponseMessage();
        let result = undefined;
        try {
            result = addStatusResponseValues(null, worker_status_msg);
        } catch(err) {
            result = err;
        }
        assert.strictEqual(result instanceof Error, true, 'Expected exception to be thrown.');
    });
    it('test addStatusResponseValues null worker status', () => {
        let worker_status_msg = buildWorkerStatusMessage();
        let result = undefined;
        try {
            result = addStatusResponseValues(null, worker_status_msg);
        } catch(err) {
            result = err;
        }
        assert.strictEqual(result instanceof Error, true, 'Expected exception to be thrown.');
    });
});

describe('Test CoreRoom publish to room', function() {
    let test_instance = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    beforeEach(() => {
        test_instance = new CoreRoom(ROOM_NAME);
        worker_stub = new WorkerStub();
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub = null;
        sandbox.restore();
    });

    it('test publishToRoom', () => {
        test_instance.publishToRoom(INBOUND_MSG_HANDLER_TEST_MSG, worker_stub, {});
        assert.strictEqual(worker_stub.publish_called, true, 'Expected publish to be called');
    });

    it('test publishToRoom, exception throw', () => {
        worker_stub.exchange.publish = (channel, req) => {
            throw new Error('This is bad');
        };
        test_instance.publishToRoom(INBOUND_MSG_HANDLER_TEST_MSG, worker_stub, {});
        // publishToRoom only logs from an exception.  Just make sure the whole thing doesnt blow up.
        assert.strictEqual(worker_stub.publish_called, false, 'Expected publish to be called');
    });
});