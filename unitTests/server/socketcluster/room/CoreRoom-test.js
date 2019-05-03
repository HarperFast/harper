"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const CoreRoom = require('../../../../server/socketcluster/room/CoreRoom');
const types = require('../../../../server/socketcluster/types');

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

describe('Test CoreRoom evalRules', function() {
    let test_instance = undefined;
    let matrix_stub = undefined;
    let sandbox = sinon.createSandbox();
    let worker_stub = undefined;
    beforeEach(() => {
        test_instance = new CoreRoom(ROOM_NAME);
        worker_stub = new WorkerStub();
        matrix_stub = new DecisionMatrixStub();
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