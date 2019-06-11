"use strict";
const RuleIF = require('./RulesIF');
const types = require('../../types');
/**
 * This rule is used as the 'base', or first node, in the RulesCollection linked list.
 */
class BaseRule extends RuleIF {
    constructor() {
        super();
        this.command_order = null;
        this.type = types.RULE_TYPE_ENUM.BASE_TYPE;
    }
    async evaluateRule() {
        throw new Error('Should not be evaluating the base rule');
    }
}
module.exports = BaseRule;