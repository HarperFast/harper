"use strict";

const test_util = require('../../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const PostToExchangeWorkerRule = require('../../../../../server/socketcluster/decisionMatrix/rules/PostToExchangeWorkerRule');
const types = require('../../../../../server/socketcluster/types');

const WORKER_NAME = 'asdfesd';

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
    let worker_exchange_publish_stub = undefined;

    let worker_stub = new WorkerStub();
    let worker_exchange_publish_orig = worker_stub.exchange.publish;

        beforeEach(() => {
        test_instance = new PostToExchangeWorkerRule();
    });
    afterEach(() => {
        test_instance = undefined;
        worker_stub.hdb_workers = [];
        worker_stub.exchange.publish = worker_exchange_publish_orig;
        sandbox.restore();
    });
    it('nominal, test construction', () => {
        assert.notEqual(test_instance.id, undefined, 'Expected id to not be null');
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.LOW, 'Expected default command order');
    });

    it('nominal, test eval', async () => {
        worker_exchange_publish_stub = sandbox.stub().returns('done');
        worker_stub.exchange.publish = worker_exchange_publish_stub;
        worker_stub.hdb_workers.push(WORKER_NAME);
        let result = undefined;
        try {
            result = await test_instance.evaluateRule(TEST_REQUEST, {}, worker_stub);
        } catch(err) {
            result = err;
        }
        assert.equal(result, true, 'expected success');
        assert.equal(worker_exchange_publish_stub.calledOnce, true, 'expected worker publish function to be called');
    });
    it('test eval with invalid worker.', async () => {
        worker_exchange_publish_stub = sandbox.stub().returns('done');
        worker_stub.exchange.publish = worker_exchange_publish_stub;
        worker_stub.hdb_workers.push(WORKER_NAME);
        let result = undefined;
        try {
            result = await test_instance.evaluateRule(TEST_REQUEST, {}, null);
        } catch(err) {
            result = err;
        }
        assert.equal(result, false, 'expected failure');
    });
    it('test eval with empty channel.', async () => {
        worker_exchange_publish_stub = sandbox.stub().returns('done');
        worker_stub.exchange.publish = worker_exchange_publish_stub;
        let request_copy = test_util.deepClone(TEST_REQUEST);
        request_copy.data = null;
        let result = undefined;
        try {
            result = await test_instance.evaluateRule(request_copy, {}, worker_stub);
        } catch(err) {
            result = err;
        }
        assert.equal(result, false, 'expected failure');
    });
    it('test eval with publish exception thrown.', async () => {
        worker_exchange_publish_stub = sandbox.stub().throws(new Error('Bad publish'));
        worker_stub.exchange.publish = worker_exchange_publish_stub;
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