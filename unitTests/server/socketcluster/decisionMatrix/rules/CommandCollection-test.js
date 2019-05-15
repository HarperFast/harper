'use strict';

const test_util = require('../../../../test_utils');
test_util.preTestPrep();

const assert = require('assert');
const rewire = require('rewire');
const sinon = require('sinon');
const RulesCollection = require('../../../../../server/socketcluster/decisionMatrix/rules/CommandCollection');
const TestRule = require('../../../../../server/socketcluster/decisionMatrix/rules/TestRule');
const DummyRule = require('../../../../../server/socketcluster/decisionMatrix/rules/DummyRule');
const types = require('../../../../../server/socketcluster/types');

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

describe('Test removeCommand', function() {
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

    it('Nominal, remove middle command', () => {
        collection.addCommand(VERY_FIRST_RULE);
        collection.addCommand(FIRST_RULE);
        collection.addCommand(MID_RULE);
        collection.addCommand(LAST_RULE);
        collection.addCommand(VERY_LAST_RULE);
        let result = undefined;
        try {
            result = collection.removeCommand(VERY_FIRST_RULE.id);
        } catch(err) {
            result = err;
        }
        assert.equal(result, true, 'expected success');
        let remaining_commands = collection.getCommands();
        assert.equal(remaining_commands.length, 4, 'Expected 4 commands');
        assert.equal(remaining_commands[0].command_order, types.COMMAND_EVAL_ORDER_ENUM.HIGH);
        assert.equal(remaining_commands[1].command_order, types.COMMAND_EVAL_ORDER_ENUM.MID);
        assert.equal(remaining_commands[2].command_order, types.COMMAND_EVAL_ORDER_ENUM.LOW);
        assert.equal(remaining_commands[3].command_order, types.COMMAND_EVAL_ORDER_ENUM.VERY_LAST);
    });
    it('Nominal, remove only command', () => {
        collection.addCommand(MID_RULE);
        let result = undefined;
        try {
            result = collection.removeCommand(MID_RULE.id);
        } catch(err) {
            result = err;
        }
        assert.equal(result, true, 'expected success');
        let remaining_commands = collection.getCommands();
        assert.equal(remaining_commands.length, 0, 'Expected 0 commands');
    });
    it('Nominal, command not found', () => {
        collection.addCommand(MID_RULE);
        let result = undefined;
        try {
            result = collection.removeCommand('notanid');
        } catch(err) {
            result = err;
        }
        assert.equal(result, false, 'expected success');
        let remaining_commands = collection.getCommands();
        assert.equal(remaining_commands.length, 1, 'Expected 0 commands');
    });
    it('Call remove on empty collection', () => {
        let result = undefined;
        try {
            result = collection.removeCommand('notanid');
        } catch(err) {
            result = err;
        }
        assert.equal(result, false, 'expected success');
        let remaining_commands = collection.getCommands();
        assert.equal(remaining_commands.length, 0, 'Expected 0 commands');
    });
});

describe('Test findLastInstanceOfEvalOrder', function() {
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

    it('Nominal, find first rule which is last in the list', () => {
        collection.addCommand(VERY_FIRST_RULE);
        collection.addCommand(FIRST_RULE);
        collection.addCommand(MID_RULE);

        let result = undefined;
        try {
            result = collection.findLastInstanceOfEvalOrder(FIRST_RULE.command_order);
        } catch(err) {
            result = err;
        }
        assert.notEqual(result, undefined, 'expected success');
        assert(result.data.command_order, types.COMMAND_EVAL_ORDER_ENUM.HIGH, 'expected mid rule list node');
    });
    it('search for rule not in collection, expect last rule in collection back', () => {
        collection.addCommand(VERY_FIRST_RULE);
        collection.addCommand(FIRST_RULE);
        collection.addCommand(MID_RULE);

        let result = undefined;
        try {
            result = collection.findLastInstanceOfEvalOrder(VERY_LAST_RULE.command_order);
        } catch(err) {
            result = err;
        }
        assert.equal(result.data.id, MID_RULE.id, 'expected last node back');
    });
    it('search for rule with duplicate orders in collection', () => {
        collection.addCommand(VERY_FIRST_RULE);
        collection.addCommand(FIRST_RULE);
        collection.addCommand(MID_RULE);
        collection.addCommand(NEXT_MID_RULE);

        let result = undefined;
        try {
            result = collection.findLastInstanceOfEvalOrder(VERY_LAST_RULE.command_order);
        } catch(err) {
            result = err;
        }
        assert.equal(result.data.id, NEXT_MID_RULE.id, 'expected last mid rule id');
    });
    it('search for rule with lower command order than any in the collection, expect base back', () => {
        collection.addCommand(VERY_LAST_RULE);
        collection.addCommand(LAST_RULE);

        let result = undefined;
        try {
            result = collection.findLastInstanceOfEvalOrder(FIRST_RULE.command_order);
        } catch(err) {
            result = err;
        }
        assert.equal(result.data instanceof DummyRule, true, 'expected last mid rule id');
    });
});

describe('Test insertCommandDontCallMeExternallyUseAddCommand', function() {
    let sandbox = null;
    let collection = null;
    let base = undefined;
    beforeEach(function () {
        sandbox = sinon.createSandbox();
        collection = new RulesCollection();
        base = collection.base;
    });
    afterEach(function () {
        sandbox.restore();
        collection = null;
    });
    it('Nominal case, insert after base', () => {
        collection.insertCommandDontCallMeExternallyUseAddCommand(MID_RULE, base);
        assert.equal(base.next.data.id, MID_RULE.id, 'expected last mid rule id');
        collection.insertCommandDontCallMeExternallyUseAddCommand(VERY_LAST_RULE, base.next);
        assert.equal(base.next.data.id, MID_RULE.id, 'expected last mid rule id');
        assert.equal(base.next.next.data.id, VERY_LAST_RULE.id, 'expected last mid rule id');
    });
    it('insert on null list item', () => {
        let result = undefined;
        result = collection.insertCommandDontCallMeExternallyUseAddCommand(MID_RULE, null);
        assert.equal(base.next, null, 'expected last mid rule id');
        assert.equal(result, false, 'expected failure');
    });
    it('insert on Rule instead of list item', () => {
        let result = undefined;
        result = collection.insertCommandDontCallMeExternallyUseAddCommand(MID_RULE, new TestRule());
        assert.equal(base.next, null, 'expected last mid rule id');
        assert.equal(result, false, 'expected failure');
    });
    it('insert null rule', () => {
        let result = undefined;
        result = collection.insertCommandDontCallMeExternallyUseAddCommand(null, base);
        assert.equal(base.next, null, 'expected last mid rule id');
        assert.equal(result, false, 'expected failure');
    });
});

describe('Test printCommands', function() {
    let collection = null;
    beforeEach(function () {
        collection = new RulesCollection();
    });
    afterEach(function () {
        collection = null;
    });
    it('Nominal case, print with 1 of each rule', () => {
        collection.addCommand(VERY_FIRST_RULE);
        collection.addCommand(FIRST_RULE);
        collection.addCommand(MID_RULE);
        collection.addCommand(LAST_RULE);
        collection.addCommand(VERY_LAST_RULE);

        collection.printCommands(true);
    });
    it('print with no rules', () => {
        collection.printCommands(true);
    });
});

describe('Test getCommands', function() {
    let collection = null;
    beforeEach(function () {
        collection = new RulesCollection();
    });
    afterEach(function () {
        collection = null;
    });
    it('Nominal case, get with 5 rules', () => {
        collection.addCommand(MID_RULE);
        collection.addCommand(VERY_FIRST_RULE);
        collection.addCommand(LAST_RULE);
        collection.addCommand(FIRST_RULE);
        collection.addCommand(VERY_LAST_RULE);

        let found = collection.getCommands();
        assert.equal(found.length, 5, 'expected 5 elements in array');
        assert.equal(found instanceof Array, true, 'expected array back');
        assert.equal(found[0].id, VERY_FIRST_RULE.id, 'expected very first rule as 0th');
        assert.equal(found[1].id, FIRST_RULE.id, 'expected very first rule as 0th');
        assert.equal(found[2].id, MID_RULE.id, 'expected very first rule as 0th');
        assert.equal(found[3].id, LAST_RULE.id, 'expected very first rule as 0th');
        assert.equal(found[4].id, VERY_LAST_RULE.id, 'expected very first rule as 0th');
    });
    it('Call on empty collection, expect empty array back', () => {

        let found = collection.getCommands();
        assert.equal(found.length, 0, 'expected 5 elements in array');
        assert.equal(found instanceof Array, true, 'expected array back');
    });
});