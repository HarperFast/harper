"use strict";
const RuleIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');
const terms = require('../../../../utility/hdbTerms');

/**
 * This worker rule strips the internal hdb_header from the request before it is sent on.
 */
class StripHdbHeaderRule extends RuleIF {
    constructor() {
        super();
        this.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.LOW);
        this.type = types.RULE_TYPE_ENUM.CALL_ROOM_MSG_HANDLER;
    }

    /**
     * Evaluate the request against this rule.  Return true if the request passes the rule, false if it does not.
     * @param req - the request
     * @param args - any arguments that are needed during rule evaluation, can be null.
     * @param worker - the worker this rule belongs to.
     * @returns {Promise<boolean>}
     */
    async evaluateRule(req, args, worker) {
        log.trace('Evaluating strip hdb header handler rule');
        try {
            delete req[types.HDB_HEADER_NAME];
            delete req.data[types.HDB_HEADER_NAME];
        } catch(err) {
            log.trace('failed strip hdb header handler rule');
            log.error(err);
            return false;
        }
        return true;
    }
}
module.exports = StripHdbHeaderRule;