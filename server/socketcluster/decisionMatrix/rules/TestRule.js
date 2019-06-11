"use strict";
const RuleIF = require('./RulesIF');
const types = require('../../types');
/**
 * This rule is used in the RulesCollection unit tests.  It should probably exist in unitTests, but could serve as documentation so I left it here.
 */
class TestRule extends RuleIF {
    constructor() {
        super();
        this.type = types.RULE_TYPE_ENUM.TEST_RULE;
    }
    async evaluateRule(req, args, worker) {
        console.log("Test rule");
        return true;
    }
}
module.exports = TestRule;