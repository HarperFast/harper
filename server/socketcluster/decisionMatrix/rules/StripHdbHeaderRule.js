"use strict";
const RuleIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');
const terms = require('../../../../utility/hdbTerms');

/**
 * This worker rule sends a request via socketcluster to an HDBChild for processing in core.
 */
class StripHdbHeaderRule extends RuleIF {
    constructor() {
        super();
        this.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.LOW);
        this.type = types.RULE_TYPE_ENUM.CALL_ROOM_MSG_HANDLER;
    }

    async evaluateRule(req, args, worker) {
        log.trace('Evaluating strip hdb header handler rule');
        try {
            delete req[types.HDB_HEADER_NAME];
            delete req.data[types.HDB_HEADER_NAME];
        } catch(err) {
            log.error(err);
            return false;
        }
        return true;
    }
}
module.exports = StripHdbHeaderRule;