"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const RoomIF = require('../../../../server/socketcluster/room/RoomIF');
const GenericMiddleware = require('../../../../server/socketcluster/middleware/GenericMiddleware');
const types = require('../../../../server/socketcluster/types');
const CommandCollection = require('../../../../server/socketcluster/decisionMatrix/rules/CommandCollection');
const ROOM_NAME = 'dev.tester';
const WORKER_NAME = 'asdfesd';

class WorkerStub {
    constructor() {
        this['exchange'] = {};
        this.exchange.publish = (hdbChild, data) => {
            console.log('Called publish');
        };
        this.hdb_workers = [];
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

describe('Test RoomIF addMiddleware', function() {
    let test_instance = undefined;
    let matrix_stub = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    beforeEach(() => {
        test_instance = new RoomIF(ROOM_NAME);
        worker_stub = new WorkerStub();
        matrix_stub = new DecisionMatrixStub();
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub = null;
        matrix_stub = null;
        sandbox.restore();
    });

    it('test addMiddleware', () => {
        test_instance.addMiddleware(new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {return true;}), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        test_instance.addMiddleware(new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {return true;}), types.CONNECTOR_TYPE_ENUM.CORE);
        // check all collections to make sure not added to anything else
        //assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_SC].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_AUTHENTICATE].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_WS].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_EMIT].getCommands().length, 0, 'expected no middleware to be added');

        // should only see something in publishin
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_SC].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_AUTHENTICATE].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_WS].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_EMIT].getCommands().length, 0, 'expected no middleware to be added');
    });

    it('test add empty middleware, all should be empty', () => {
        test_instance.addMiddleware(null, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        // check all collections to make sure not added to anything else
        //assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 0, 'expected 0 middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_SC].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_AUTHENTICATE].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_WS].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_EMIT].getCommands().length, 0, 'expected no middleware to be added');

        // should only see something in publishin
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 0, 'expected 0 middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_SC].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_AUTHENTICATE].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_WS].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_EMIT].getCommands().length, 0, 'expected no middleware to be added');
    });

    it('test add with empty connector type, expect to be added to default (cluster)', () => {
        test_instance.addMiddleware(new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {}), null);
        // check all collections to make sure not added to anything else
        //assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 0, 'expected 1 middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_SC].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_AUTHENTICATE].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_WS].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_EMIT].getCommands().length, 0, 'expected no middleware to be added');

        // should only see something in publishin
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_OUT].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_SC].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_AUTHENTICATE].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_HANDSHAKE_WS].getCommands().length, 0, 'expected no middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_EMIT].getCommands().length, 0, 'expected no middleware to be added');
    });
});

describe('Test RoomIF evalMiddleware', function() {
    let test_instance = undefined;
    let matrix_stub = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    beforeEach(() => {
        test_instance = new RoomIF();
        test_instance.setTopic(ROOM_NAME);
        worker_stub = new WorkerStub();
        matrix_stub = new DecisionMatrixStub();
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub = null;
        matrix_stub = null;
        sandbox.restore();
    });

    it('test setTopic', () => {
        let new_topic = 'newTopic';
        test_instance.setTopic(new_topic);
        assert.equal(test_instance.topic, new_topic, 'expected topic change.');
    });

    it('test setTopic - invalid topic', () => {
        let new_topic = null;
        assert.equal(test_instance.topic, ROOM_NAME, 'expected topic change.');
        test_instance.setTopic(new_topic);
        assert.equal(test_instance.topic, ROOM_NAME, 'expected topic change.');
    });
});

describe('Test RoomIF setDecisionMatrix', function() {
    let test_instance = undefined;
    let matrix_stub = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    beforeEach(() => {
        test_instance = new RoomIF();
        test_instance.setTopic(ROOM_NAME);
        worker_stub = new WorkerStub();
        matrix_stub = new DecisionMatrixStub();
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub = null;
        matrix_stub = null;
        sandbox.restore();
    });

    it('test nominal setDecisionMatrix', () => {
        assert.equal(test_instance.decision_matrix, null, 'expected null decision matrix.');
        test_instance.setDecisionMatrix(matrix_stub);
        assert.notEqual(test_instance.decision_matrix, null, 'expected null decision matrix.');
    });

    it('test setDecisionMatrix with null parameter', () => {
        assert.equal(test_instance.decision_matrix, null, 'expected null decision matrix.');
        test_instance.setDecisionMatrix(matrix_stub);
        assert.notEqual(test_instance.decision_matrix, null, 'expected null decision matrix.');
        let result = null;
        try {
            test_instance.setDecisionMatrix(null);
        } catch(err) {
            result = err;
        }
        assert.equal(result instanceof Error, true, 'expected exception.');
    });
});

describe('Test RoomIF evalMiddleware', function() {
    let test_instance = undefined;
    let matrix_stub = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    let collection_stub = undefined;
    beforeEach(() => {
        test_instance = new RoomIF();
        test_instance.setTopic(ROOM_NAME);
        worker_stub = new WorkerStub();
        matrix_stub = new DecisionMatrixStub();
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub = null;
        matrix_stub = null;
        sandbox.restore();
    });

    it('nominal evalMiddleware', async ()=> {
        let test_middleware = new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {});
        collection_stub = sandbox.stub(CommandCollection.prototype, 'getCommands').returns([test_middleware]);

        let result = undefined;
        try {
            result = await test_instance.evalMiddleware(TEST_REQUEST, () => {}, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);
        } catch(err) {
            result = err;
        }

        assert.equal(result, undefined, 'Expected success');
    });
    it('nominal evalMiddleware with middleware failure', async ()=> {
        let pass_middleware = new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {});
        let fail_middleware = new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {return types.ERROR_CODES.MIDDLEWARE_SWALLOW;});
        collection_stub = sandbox.stub(CommandCollection.prototype, 'getCommands').returns([pass_middleware, fail_middleware]);

        let result = undefined;
        try {
            result = await test_instance.evalMiddleware(TEST_REQUEST, () => {}, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);
        } catch(err) {
            result = err;
        }

        assert.equal(result, types.ERROR_CODES.MIDDLEWARE_SWALLOW, 'Expected middleware swallow');
    });
    it('nominal evalMiddleware with no middleware found', async ()=> {
        collection_stub = sandbox.stub(CommandCollection.prototype, 'getCommands').returns([]);

        let result = undefined;
        try {
            result = await test_instance.evalMiddleware(TEST_REQUEST, () => {}, types.MIDDLEWARE_TYPE.MIDDLEWARE_SUBSCRIBE);
        } catch(err) {
            result = err;
        }

        assert.equal(result, null, 'Expected success');
    });
    it('nominal evalMiddleware with transacted set in req so get cluster collection', async ()=> {
        // This test adds failing middleware to publishin of core, then calls evalMiddleware with cluster set in the request header.  Make sure we grab the cluster publishin collection. if the
        // core collection were to be called, the failing middlware would be called.
        let fail_middleware = new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {return types.ERROR_CODES.MIDDLEWARE_SWALLOW;});
        test_instance.addMiddleware(fail_middleware, types.CONNECTOR_TYPE_ENUM.CORE);
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'Expected middleware exists');
        let req = test_util.deepClone(TEST_REQUEST);
        req.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE] = types.CONNECTOR_TYPE_ENUM.CLUSTER;
        let result = undefined;
        try {
            result = await test_instance.evalMiddleware(TEST_REQUEST, () => {}, types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN);
        } catch(err) {
            result = err;
        }

        assert.equal(result, null, 'Expected success');
    });
});

describe('Test RoomIF removeMiddleware', function() {
    let test_instance = undefined;
    let matrix_stub = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    beforeEach(() => {
        test_instance = new RoomIF(ROOM_NAME);
        worker_stub = new WorkerStub();
        matrix_stub = new DecisionMatrixStub();
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub = null;
        matrix_stub = null;
        sandbox.restore();
    });

    it('test removeMiddleware', () => {
        test_instance.addMiddleware(new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {return true;}), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        test_instance.addMiddleware(new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {return true;}), types.CONNECTOR_TYPE_ENUM.CORE);
        // check add worked properly
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');

        //enum_middleware_type, premade_middleware_type_enum, connector_type_enum) {
        test_instance.removeMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, types.PREMADE_MIDDLEWARE_TYPES.GENERIC, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        test_instance.removeMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, types.PREMADE_MIDDLEWARE_TYPES.GENERIC, types.CONNECTOR_TYPE_ENUM.CORE);

        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 0, 'expected 0 middleware left');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 0, 'expected 0 middleware left');
    });

    it('test remove middleware that doesnt exist, should remain unchanged.', () => {
        test_instance.addMiddleware(new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {return true;}), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        test_instance.addMiddleware(new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {return true;}), types.CONNECTOR_TYPE_ENUM.CORE);
        // check add worked properly
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');

        //enum_middleware_type, premade_middleware_type_enum, connector_type_enum) {
        test_instance.removeMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, types.PREMADE_MIDDLEWARE_TYPES.AUTH, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        test_instance.removeMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, types.PREMADE_MIDDLEWARE_TYPES.AUTH, types.CONNECTOR_TYPE_ENUM.CORE);

        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');
    });

    it('test add with empty connector type, no default support so remain unchanged.', () => {
        test_instance.addMiddleware(new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {return true;}), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        test_instance.addMiddleware(new GenericMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, () => {return true;}), types.CONNECTOR_TYPE_ENUM.CORE);
        // check add worked properly
        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');

        //enum_middleware_type, premade_middleware_type_enum, connector_type_enum) {
        test_instance.removeMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, types.PREMADE_MIDDLEWARE_TYPES.AUTH, null);
        test_instance.removeMiddleware(types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN, types.PREMADE_MIDDLEWARE_TYPES.AUTH, null);

        assert.equal(test_instance.core_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');
        assert.equal(test_instance.connector_middleware[types.MIDDLEWARE_TYPE.MIDDLEWARE_PUBLISH_IN].getCommands().length, 1, 'expected 1 middleware to be added');
    });
});