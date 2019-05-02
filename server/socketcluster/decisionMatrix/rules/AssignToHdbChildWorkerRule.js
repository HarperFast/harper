"use strict";
const RuleIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');

/**
 * This worker rule sends a request via socketcluster to an HDBChild for processing in core.
 */
class AssignToHdbChildWorkerRule extends RuleIF {
    constructor() {
        super();
        this.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.VERY_LAST);
    }
    evaluateRule(req, args, worker) {
        log.trace('Evaluating Assign to Hdb Child worker rule');
        try {
            if (req.channel.indexOf('internal:') < 0) {
                let target = req.channel.split(':');
                req.data.schema = target[0];
                req.data.table = target[1];
            }
            let rand = Math.floor(Math.random() * worker.hdb_workers.length);
            let random_worker = worker.hdb_workers[rand];

            worker.exchange.publish(random_worker, req.data);
        } catch(err) {
            log.error(err);
            return false;
        }
        return true;
    }
}
module.exports = AssignToHdbChildWorkerRule;