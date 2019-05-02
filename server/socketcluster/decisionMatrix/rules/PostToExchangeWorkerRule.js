"use strict";
const RuleIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');

/**
 * This worker rule should be called after a request has passed all middleware and rules.  It will post a message to
 * the exchange on the <schema>:<table> room.
 */
class PostToExchangeWorkerRule extends RuleIF {
    constructor() {
        super();
        this.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.LOW);
    }
    evaluateRule(req, args, worker) {
        log.trace('Evaluating post to exchange worker rule');
        if(!req || !req.channel || !req.data) {
            log.error('Invalid request data, not posting to exchange.');
            return false;
        }
        try {
            worker.exchange.publish(req.channel, req.data);
        } catch(err) {
            log.error(err);
            return false;
        }
        return true;
    }
}
module.exports = PostToExchangeWorkerRule;