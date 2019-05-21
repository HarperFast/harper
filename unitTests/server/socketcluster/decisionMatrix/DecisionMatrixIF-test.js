"use strict";

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const DecisionMatrixIF = require('../../../../server/socketcluster/decisionMatrix/DecisionMatrixIF');
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

describe('Test addRule', function() {

    let test_instance = undefined;
    beforeEach(() => {
        test_instance = new DecisionMatrixIF();
    });
    afterEach(() => {
        test_instance = null;
    });
    it('Nominal test with Cluster connector source', () => {
        let result = undefined;
        try {
            test_instance.addRule(new TestRule(), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CLUSTER).length, 1, 'expected 1 rule');
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CORE).length, 0, 'expected 0 rules');
    });
    it('Nominal test with Core connector source', () => {
        let result = undefined;
        try {
            test_instance.addRule(new TestRule(), types.CONNECTOR_TYPE_ENUM.CORE);
        } catch(err) {
            result = err;
        }
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CLUSTER).length, 0, 'expected 0 rules');
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CORE).length, 1, 'expected 1 rule');
    });
    it(' test with null connector source', () => {
        let result = undefined;
        try {
            test_instance.addRule(new TestRule(), null);
        } catch(err) {
            result = err;
        }
        assert.equal((result instanceof Error), true, 'expected error');
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CLUSTER).length, 0, 'expected 1 rule');
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CORE).length, 0, 'expected 0 rules');
    });
    it(' test with null rule', () => {
        let result = undefined;
        try {
            test_instance.addRule(null, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal((result instanceof Error), true, 'expected error');
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CLUSTER).length, 0, 'expected 1 rule');
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CORE).length, 0, 'expected 0 rules');
    });
});

describe('Test evalRules', function() {
    let test_instance = undefined;
    beforeEach(() => {
        test_instance = new DecisionMatrixIF();
    });
    afterEach(() => {
        test_instance = null;
    });
    it('expect not implemented exception', async () => {
        let result = undefined;
        try {
            await test_instance.evalRules(new TestRule(), types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal((result instanceof Error), true, 'expected error');
    });
});

describe('Test removeRule', function() {
    let test_instance = undefined;
    beforeEach(() => {
        test_instance = new DecisionMatrixIF();
    });
    afterEach(() => {
        test_instance = null;
    });
    it('nominal, remove rule with cluster data source', async () => {
        let test_rule = new TestRule();
        test_instance.addRule(test_rule, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        let result = undefined;
        try {
            test_instance.removeRule(test_rule.id, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CORE).length, 0, 'expected 0 rules');
    });
    it('nominal, remove rule with core data source', async () => {
        let test_rule = new TestRule();
        test_instance.addRule(test_rule, types.CONNECTOR_TYPE_ENUM.CORE);
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CORE).length, 1, 'expected 1 rules');
        let result = undefined;
        try {
            test_instance.removeRule(test_rule.id, types.CONNECTOR_TYPE_ENUM.CORE);
        } catch(err) {
            result = err;
        }
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CORE).length, 0, 'expected 0 rules');
    });
    it('remove rule with invalid connector', async () => {
        let test_rule = new TestRule();
        test_instance.addRule(test_rule, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        let result = undefined;
        try {
            test_instance.removeRule(test_rule.id, null);
        } catch(err) {
            result = err;
        }
        assert.equal((result instanceof Error), true, 'expected error');
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CLUSTER).length, 1, 'expected 1 rules');
    });
    it('remove rule with invalid rule id', async () => {
        let test_rule = new TestRule();
        test_instance.addRule(test_rule, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        let result = undefined;
        try {
            test_instance.removeRule(null, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal((result instanceof Error), true, 'expected error');
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CLUSTER).length, 1, 'expected 1 rules');
    });
    it('remove rule with invalid rule id', async () => {
        let test_rule = new TestRule();
        test_instance.addRule(test_rule, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        let result = undefined;
        try {
            test_instance.removeRule(null, types.CONNECTOR_TYPE_ENUM.CLUSTER);
        } catch(err) {
            result = err;
        }
        assert.equal((result instanceof Error), true, 'expected error');
        assert.equal(test_instance.listRules(types.CONNECTOR_TYPE_ENUM.CLUSTER).length, 1, 'expected 1 rules');
    });
});