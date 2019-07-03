"use strict";
const RuleIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');
const env = require('../../../../utility/environment/environmentManager');
env.initSync();
const HDB_QUEUE_PATH = env.getHdbBasePath() + '/schema/system/hdb_queue/';
const fs = require('fs-extra');

const LINE_DELIMITER = '\r\n';
const VALID_OPERATIONS = ['insert', 'update', 'delete'];

/**
 * This worker rule should be called after a request has passed all middleware and rules.  It will post a message to
 * the exchange on the <schema>:<table> room.
 */
class WriteToTransactionLogRule extends RuleIF {
    constructor() {
        super();
        this.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.LOW);
        this.type = types.RULE_TYPE_ENUM.WRITE_TO_TRANSACTION_LOG;
        this.pending_transaction_stream = undefined;
        this.transaction_stream = undefined;
    }

    /**
     * Evaluate the request against this rule.  Return true if the request passes the rule, false if it does not.
     * @param req - the request
     * @param args - any arguments that are needed during rule evaluation, can be null.
     * @param worker - the worker this rule belongs to.
     * @returns {Promise<boolean>}
     */
    async evaluateRule(req, args, worker) {
        if(req.data.__transacted !== true){
            return true;
        }

        log.trace('Evaluating write to transaction log rule');
        if(!req || !req.channel || !req.data) {
            log.error('Invalid request data, not writing to transaction log.');
            return true;
        }

        delete req.data.__transacted;

        if(VALID_OPERATIONS.indexOf(req.data.transaction.operation) < 0){
            log.debug('Invalid operation, not writing to transaction log.');
            return true;
        }

        try {
            if(this.transaction_stream === undefined){
                this.transaction_stream = fs.createWriteStream(HDB_QUEUE_PATH + req.channel, {flags:'a'});
            }

            let transaction_csv = req.data.timestamp + ',' + req.data.__id + ',' + req.data.transaction.operation + ',';

            if(req.data.transaction.operation === 'insert' || req.data.transaction.operation === 'update'){
                transaction_csv += JSON.stringify(req.data.transaction.records, this.escape);
            } else if(req.data.transaction.operation === 'delete') {
                transaction_csv += JSON.stringify(req.data.transaction.hash_values, this.escape);
            }

            transaction_csv += LINE_DELIMITER;
            this.transaction_stream.write(transaction_csv);
        } catch(err) {
            log.trace('failed write to transaction log rule');
            log.error(err);
            return false;
        }
        return true;
    }

    escape (key, val) {
        if (typeof(val)!="string") return val;
        return val
            .replace(/[\"]/g, '\\"')
            .replace(/[\\]/g, '\\\\')
            .replace(/[\/]/g, '\\/')
            .replace(/[\b]/g, '\\b')
            .replace(/[\f]/g, '\\f')
            .replace(/[\n]/g, '\\n')
            .replace(/[\r]/g, '\\r')
            .replace(/[\t]/g, '\\t');
    }

}
module.exports = WriteToTransactionLogRule;