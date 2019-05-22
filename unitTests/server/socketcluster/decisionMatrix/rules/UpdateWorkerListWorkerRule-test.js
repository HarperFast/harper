"use strict";

const test_util = require('../../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const UpdateWorkerListWorkerRule = require('../../../../../server/socketcluster/decisionMatrix/rules/UpdateWorkerListWorkerRule');
const types = require('../../../../../server/socketcluster/types');

class WorkerStub {
    constructor() {
        this['exchange'] = {};
        this.exchange.publish = (hdbChild, data) => {
            console.log('Called publish');
        };
        this.exchange_get = (channel, callback) => {
            console.log('Called exchange_get');
            return callback(null, {WORKER_NAME: 'imAnHdbChild'});
        };
        this.hdb_workers = [];
    }
};

const ROOM_NAME = 'dev.tester';
const WORKER_NAME = 'asdfesd';
const INTERNAL_ROOM_NAME = `internal:${WORKER_NAME}`;

const TEST_REQUEST = {
    channel: ROOM_NAME,
    data: {},
    hdb_header: {}
};
TEST_REQUEST.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE] = types.CONNECTOR_TYPE_ENUM.CLUSTER;

describe('Test RuleIF', function() {
    let test_instance = undefined;
    let sandbox = sinon.createSandbox();
    let exchange_get_stub = undefined;
    let worker_stub = new WorkerStub();
    let exchange_get_orig = worker_stub.exchange_get;

    beforeEach(() => {
        test_instance = new UpdateWorkerListWorkerRule();
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub.hdb_workers = [];
        sandbox.restore();
    });
    it('nominal, test construction', () => {
        assert.notEqual(test_instance.id, undefined, 'Expected id to not be null');
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.HIGH, 'Expected default command order');
    });

    it('nominal, test eval', async () => {
        exchange_get_stub = sandbox.stub().returns('done');
        let result = undefined;
        try {
            result = await test_instance.evaluateRule(TEST_REQUEST, {}, worker_stub);
        } catch(err) {
            result = err;
        }
        assert.equal(result, true, 'expected success');
        assert.equal(worker_stub.hdb_workers.length, 1, 'expected worker in list');
    });
    it('test eval with invalid worker.', async () => {
        exchange_get_stub = sandbox.stub().yields(null, {WORKER_NAME: 'imAnHdbChild'});
        worker_stub.exchange_get = exchange_get_stub;
        worker_stub.hdb_workers.push(WORKER_NAME);
        let result = undefined;
        try {
            result = await test_instance.evaluateRule(TEST_REQUEST, {}, null);
        } catch(err) {
            result = err;
        }
        assert.equal(result, false, 'expected failure');
    });
    it('test eval with bad results returned.', async () => {
        exchange_get_stub = sandbox.stub().yields(null, null);
        worker_stub.exchange_get = exchange_get_stub;
        worker_stub.hdb_workers.push(WORKER_NAME);
        let result = undefined;
        try {
            result = await test_instance.evaluateRule(TEST_REQUEST, {}, worker_stub);
        } catch(err) {
            result = err;
        }
        assert.equal(result, true, 'expected success but no update');
        assert.equal(worker_stub.hdb_workers.length, 1, 'expected success but no update');
    });
    it('test eval with get exception thrown.', async () => {
        exchange_get_stub = sandbox.stub().throws(new Error('Bad publish'));
        worker_stub.exchange_get = exchange_get_stub;
        worker_stub.hdb_workers.push(WORKER_NAME);
        let result = undefined;
        try {
            result = await test_instance.evaluateRule(TEST_REQUEST, {}, worker_stub);
        } catch(err) {
            result = err;
        }
        assert.equal(result, false, 'expected failure');
    });
});