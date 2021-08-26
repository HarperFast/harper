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

    /**
     * Evaluate the request against this rule.  Return true if the request passes the rule, false if it does not.
     * @param req - the request
     * @param args - any arguments that are needed during rule evaluation, can be null.
     * @param worker - the worker this rule belongs to.
     * @returns {Promise<boolean>}
     */
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

            if(req.data.__transacted) {
                // Dont send this to core, it has already been processed.  We can't swallow it as it needs to go out to the cluster.
                return true;
            }

            //we need to pass the CLUSTERING user name on the transaction for the transaction log
            if(req.socket && req.socket.authToken && req.data.transaction){
                req.data.transaction.hdb_user = {username: req.socket.authToken.username};
            }

            let rand = Math.floor(Math.random() * worker.hdb_workers.length);
            let random_worker = worker.hdb_workers[rand];
            log.trace(`Assigning message to worker: ${random_worker}`);
            worker.exchange.publish(random_worker, req.data);
            log.debug(`Transacted flag not found, swallowing message.`);
            return false;

        } catch(err) {
            log.trace('Failed Assign to Hdb Child worker rule');
            log.error(err);
            return false;
        }
    }
}
module.exports = AssignToHdbChildWorkerRule;