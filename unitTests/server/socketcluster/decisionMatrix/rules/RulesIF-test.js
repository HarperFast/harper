"use strict";

const test_util = require('../../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const RulesIF = require('../../../../../server/socketcluster/decisionMatrix/rules/RulesIF');
const types = require('../../../../../server/socketcluster/types');

describe('Test RuleIF', function() {
    let test_instance = undefined;

    it('nominal, test construction', () => {
        test_instance = new RulesIF();
        assert.notEqual(test_instance.id, undefined, 'Expected id to not be null');
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'Expected default command order');
    });

    it('nominal, test setRuleOrder', () => {
        test_instance = new RulesIF();
        test_instance.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST);
        assert.notEqual(test_instance.id, undefined, 'Expected id to not be null');
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST, 'Expected default command order');
    });
    it('test setRuleOrder with null parameter', () => {
        test_instance = new RulesIF();
        test_instance.setRuleOrder(null);
        assert.equal(test_instance.command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'Expected default command order');
    });
    it('test calling evaluateRule, expect exception', async () => {
        test_instance = new RulesIF();
        let result = undefined;
        try {
            result = await test_instance.evaluateRule(null);
        } catch(err) {
            result = err;
        }
        assert.equal((result instanceof Error), true, 'Expected exception');
    });
});