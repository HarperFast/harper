"use strict";

const test_util = require('../../../../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
const DummyRule = require('../../../../../server/socketcluster/decisionMatrix/rules/DummyRule');
const types = require('../../../../../server/socketcluster/types');

describe('Test RuleIF', function() {
    let test_instance = undefined;

    it('nominal, test construction', () => {
        test_instance = new DummyRule();
        assert.notEqual(test_instance.id, undefined, 'Expected id to not be null');
        assert.equal(test_instance.command_order, null, 'Expected null command order');
    });

    it('test calling evaluateRule, expect exception', async () => {
        test_instance = new DummyRule();
        let result = undefined;
        try {
            result = await test_instance.evaluateRule(null);
        } catch(err) {
            result = err;
        }
        assert.equal((result instanceof Error), true, 'Expected exception');
    });
});