"use strict";
const RuleIF = require('./RulesIF');
const types = require('../../types');

/**
 * This rule is used in the RulesCollection unit tests.  It should probably exist in unitTests, but could serve as documentation so I left it here.
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
        delete req.data.__transacted;
        return true;
    }
}
module.exports = CleanDataObjectRule;