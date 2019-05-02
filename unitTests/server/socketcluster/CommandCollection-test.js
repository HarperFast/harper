'use strict';

const test_util = require('../../test_utils');
test_util.preTestPrep();

const assert = require('assert');
const rewire = require('rewire');
const sinon = require('sinon');
const RulesCollection = require('../../../server/socketcluster/decisionMatrix/rules/CommandCollection');
const TestRule = require('../../../server/socketcluster/decisionMatrix/rules/TestRule');
const types = require('../../../server/socketcluster/types');

let VERY_FIRST_RULE = new TestRule();
VERY_FIRST_RULE.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST);

let FIRST_RULE = new TestRule();
FIRST_RULE.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.HIGH);

let MID_RULE = new TestRule();
MID_RULE.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.MID);

let NEXT_MID_RULE = new TestRule();
NEXT_MID_RULE.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.MID);

let LAST_RULE = new TestRule();
LAST_RULE.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.LOW);

let VERY_LAST_RULE = new TestRule();
VERY_LAST_RULE.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.VERY_LAST);

describe('Test addCommand', function() {
    let sandbox = null;
    let collection = null;
    beforeEach(function () {
        sandbox = sinon.createSandbox();
        collection = new RulesCollection();
    });
    afterEach(function () {
        sandbox.restore();
        collection = null;
    });

    it('Nominal case, add 5 rules each with a unique rule order.', function() {
        collection.addCommand(VERY_FIRST_RULE);
        assert.equal(collection.getCommands().length, 1, 'expected 1 rule in array');

        collection.addCommand(FIRST_RULE);
        assert.equal(collection.getCommands().length, 2, 'expected 2 rule in array');
        assert.equal(collection.getCommands()[0].command_order, types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[1].command_order, types.COMMAND_EVAL_ORDER_ENUM.HIGH, 'expected very first rule to be 0th element');

        collection.addCommand(MID_RULE);
        assert.equal(collection.getCommands().length, 3, 'expected 3 rule in array');
        assert.equal(collection.getCommands()[0].command_order, types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[1].command_order, types.COMMAND_EVAL_ORDER_ENUM.HIGH, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[2].command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected very first rule to be 0th element');

        collection.addCommand(NEXT_MID_RULE);
        assert.equal(collection.getCommands().length, 4, 'expected 4 rule in array');
        assert.equal(collection.getCommands()[0].command_order, types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[1].command_order, types.COMMAND_EVAL_ORDER_ENUM.HIGH, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[2].command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[3].command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected very first rule to be 0th element');

        collection.addCommand(LAST_RULE);
        assert.equal(collection.getCommands().length, 5, 'expected 5 rule in array');
        assert.equal(collection.getCommands()[0].command_order, types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[1].command_order, types.COMMAND_EVAL_ORDER_ENUM.HIGH, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[2].command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[3].command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[4].command_order, types.COMMAND_EVAL_ORDER_ENUM.LOW, 'expected very first rule to be 0th element');

        collection.addCommand(VERY_LAST_RULE);
        assert.equal(collection.getCommands().length, 6, 'expected 6 rule in array');
        assert.equal(collection.getCommands()[0].command_order, types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[1].command_order, types.COMMAND_EVAL_ORDER_ENUM.HIGH, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[2].command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[3].command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[4].command_order, types.COMMAND_EVAL_ORDER_ENUM.LOW, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[5].command_order, types.COMMAND_EVAL_ORDER_ENUM.VERY_LAST, 'expected very first rule to be 0th element');
    });

    it('Try to add 2 rules with very first set. Expect exception', function() {
        collection.addCommand(VERY_FIRST_RULE);
        assert.equal(collection.getCommands().length, 1, 'expected 1 rule in array');
        let result = null;

        try {
            collection.addCommand(VERY_FIRST_RULE);
        } catch(err) {
            result = err;
        }
        assert.equal(collection.getCommands().length, 1, 'expected 1 rule in array');
        assert.equal((result instanceof Error), true, 'expected exception');
    });

    it('Try to add 2 rules with very last set. Expect exception', function() {
        collection.addCommand(VERY_LAST_RULE);
        assert.equal(collection.getCommands().length, 1, 'expected 1 rule in array');
        let result = null;

        try {
            collection.addCommand(VERY_LAST_RULE);
        } catch(err) {
            result = err;
        }
        assert.equal(collection.getCommands().length, 1, 'expected 1 rule in array');
        assert.equal((result instanceof Error), true, 'expected exception');
    });

    it('Make sure getCommands() returns empty array when only base exists.', function() {
        assert.equal(collection.getCommands().length, 0, 'expected 1 rule in array');
    });

    it('Try to add 2 rules with very first set. Expect exception', function() {
        collection.addCommand(VERY_FIRST_RULE);
        assert.equal(collection.getCommands().length, 1, 'expected 1 rule in array');
        let result = null;

        try {
            collection.addCommand(VERY_FIRST_RULE);
        } catch(err) {
            result = err;
        }
        assert.equal(collection.getCommands().length, 1, 'expected 2 rule in array');
        assert.equal((result instanceof Error), true, 'expected exception');
    });

    it('Add very first rule after mid rule, expect very first rule first', function() {
        collection.addCommand(MID_RULE);
        assert.equal(collection.getCommands().length, 1, 'expected 1 rule in array');

        collection.addCommand(VERY_FIRST_RULE);
        assert.equal(collection.getCommands().length, 2, 'expected 2 rule in array');
        assert.equal(collection.getCommands()[0].command_order, types.COMMAND_EVAL_ORDER_ENUM.VERY_FIRST, 'expected very first rule to be 0th element');
        assert.equal(collection.getCommands()[1].command_order, types.COMMAND_EVAL_ORDER_ENUM.MID, 'expected very first rule to be 0th element');
    });

});