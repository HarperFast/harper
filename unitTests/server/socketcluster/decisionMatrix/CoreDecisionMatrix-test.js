"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const CoreDecisionMatrix = require('../../../../server/socketcluster/decisionMatrix/CoreDecisionMatrix');
const TestRule = require('../../../../server/socketcluster/decisionMatrix/rules/TestRule');
const RuleIF = require('../../../../server/socketcluster/decisionMatrix/rules/RulesIF');
const types = require('../../../../server/socketcluster/types');

class WorkerStub {
    constructor() {
        this['exchange'] = {};
        this.exchange.publish = (hdbChild, data) => {
            console.log('Called publish');
        };
        this.hdb_workers = [];
    }
};

class BadTestRule extends RuleIF {
    constructor() {
        super();
        this.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST);
    }
    evaluateRule() {
        console.log("Test rule");
        return false;
    }
}

const ROOM_NAME = 'dev.tester';
const WORKER_NAME = 'asdfesd';
const INTERNAL_ROOM_NAME = `internal:${WORKER_NAME}`;

const TEST_REQUEST = {
    channel: ROOM_NAME,
    data: {},
    hdb_header: {}
};
TEST_REQUEST.hdb_header[types.REQUEST_HEADER_ATTRIBUTE_NAMES.DATA_SOURCE] = types.CONNECTOR_TYPE_ENUM.CLUSTER;

describe('Test CoreDecisionMatrix', function() {

    let test_instance = undefined;
    let worker_stub = new WorkerStub();

    beforeEach(() => {
       test_instance = new CoreDecisionMatrix();
    });
    afterEach(() => {
       test_instance = null;
    });
    it('Nominal test with Cluster connector source', async () => {
        test_instance.addRule(new TestRule(), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        let result = undefined;
        try {
            result = await test_instance.evalRules(TEST_REQUEST, {}, worker_stub, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal(result, true, 'expected success');
    });
    it('Nominal test with Cluster connector source, multiple rules', async () => {
        test_instance.addRule(new TestRule(), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        test_instance.addRule(new TestRule(), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        test_instance.addRule(new TestRule(), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        let result = undefined;
        try {
            result = await test_instance.evalRules(TEST_REQUEST, {}, worker_stub, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal(result, true, 'expected success');
    });
    it('Nominal test with no rules', async () => {
        let result = undefined;
        try {
            result = await test_instance.evalRules(TEST_REQUEST, {}, worker_stub, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal(result, true, 'expected success');
    });
    it('Nominal test with bad connector source param, expect cluster default', async () => {
        test_instance.addRule(new TestRule(), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        let result = undefined;
        try {
            result = await test_instance.evalRules(TEST_REQUEST, {}, worker_stub, null);
        } catch(err) {
            result = err;
        }
        assert.equal(result, true, 'expected success');
    });
    it('Nominal test with core source param but no rules, expect cluster success', async () => {
        test_instance.addRule(new TestRule(), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        let result = undefined;
        try {
            result = await test_instance.evalRules(TEST_REQUEST, {}, worker_stub, types.CONNECTOR_TYPE_ENUM.CORE);
        } catch(err) {
            result = err;
        }
        assert.equal(result, true, 'expected success');
    });
    it('Test rule failure with Cluster connector source', async () => {
        test_instance.addRule(new BadTestRule(), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        let result = undefined;
        try {
            result = await test_instance.evalRules(TEST_REQUEST, {}, worker_stub, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal(result, false, 'expected failure');
    });
    it('Test rule failure due to exception with Cluster connector source', async () => {
        let exception_rule = new BadTestRule();
        exception_rule.evaluateRule = (req, args, worker) => {
            throw new Error('Rule Exception');
        };
        test_instance.addRule(exception_rule, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        let result = undefined;
        try {
            result = await test_instance.evalRules(TEST_REQUEST, {}, worker_stub, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal(result, false, 'expected failure');
    });
});