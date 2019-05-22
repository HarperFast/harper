"use strict";
const RuleIF = require('./RulesIF');

/**
 * This rule is used as the 'base', or first node, in the RulesCollection linked list.
 */
class BaseRule extends RuleIF {
    constructor() {
        super();
        this.command_order = null;
    }
    evaluateRule() {
        throw new Error('Should not be evaluating the base rule');
    }
}
module.exports = BaseRule;