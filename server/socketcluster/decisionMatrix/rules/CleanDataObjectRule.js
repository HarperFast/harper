"use strict";
const RuleIF = require('./RulesIF');
const types = require('../../types');

/**
 * This rule is used to remove the __id & __transacted  flags from the data so that they do not pollute the data on publish out.
 */
class CleanDataObjectRule extends RuleIF {
    constructor() {
        super();
        this.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.LOW);
        this.type = types.RULE_TYPE_ENUM.CLEAN_DATA_OBJECT;
    }
    evaluateRule(req, args, worker) {
        if(!req || !req.data || typeof req.data !== 'object'){
            return true;
        }

        delete req.data.__id;
        return true;
    }
}
module.exports = CleanDataObjectRule;