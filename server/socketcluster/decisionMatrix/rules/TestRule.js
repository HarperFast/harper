"use strict";
const RuleIF = require('./RulesIF');

/**
 * This rule is used in the RulesCollection unit tests.  It should probably exist in unitTests, but could serve as documentation so I left it here.
 */
class TestRule extends RuleIF {
    constructor() {
        super();
    }
    evaluateRule() {
        console.log("Test rule");
        return true;
    }
}
module.exports = TestRule;