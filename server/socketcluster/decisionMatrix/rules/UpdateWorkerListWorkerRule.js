"use strict";
const RuleIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');
const {promisify} = require('util');

/**
 * This rule updates the list of hdbChildren of the worker parameter.  This list is used to assign work to
 * children.
 */
class UpdateWorkerListWorkerRule extends RuleIF {
    constructor() {
        super();
        this.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.HIGH);
    }
    async evaluateRule(req, args, worker) {
        log.trace('Evaluating update worker list worker rule');
        if(!worker) {
            log.error('Passed invalid worker to UpdateWorkerListWorkerRule.');
            return false;
        }
        try {
            let p_exchange_get = promisify(worker.exchange_get);
            let data = await p_exchange_get('hdb_worker');
            if(data && typeof data === 'object') {
                worker.hdb_workers = Object.keys(data);
            }
        } catch(err) {
            log.error(err);
            return false;
        }
        return true;
    }
}
module.exports = UpdateWorkerListWorkerRule;