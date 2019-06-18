"use strict";
const RuleIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');
const terms = require('../../../../utility/hdbTerms');

/**
 * This worker rule sends a request via socketcluster to an HDBChild for processing in core.
 */
class AssignToHdbChildWorkerRule extends RuleIF {
    constructor() {
        super();
        this.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.LOW);
        this.type = types.RULE_TYPE_ENUM.ASSIGN_TO_HDB_WORKER;
    }
    async evaluateRule(req, args, worker) {
        log.trace('Evaluating Assign to Hdb Child worker rule');
        if(!worker) {
            log.error('invalid worker sent to AssignToHdbChildWorkerRule.');
            return false;
        }

        try {
            if (req.channel.indexOf(terms.HDB_INTERNAL_SC_CHANNEL_PREFIX) < 0) {
                let target = req.channel.split(':');
                req.data.schema = target[0];
                req.data.table = target[1];
            }
            if(!worker.hdb_workers || worker.hdb_workers.length === 0) {
                log.info('No hdbChild workers are stored. Cant send this off');
                return false;
            }
            let rand = Math.floor(Math.random() * worker.hdb_workers.length);
            let random_worker = worker.hdb_workers[rand];

            worker.exchange.publish(random_worker, req.data);
        } catch(err) {
            log.trace('Failed Assign to Hdb Child worker rule');
            log.error(err);
            return false;
        }
        return true;
    }
}
module.exports = AssignToHdbChildWorkerRule;