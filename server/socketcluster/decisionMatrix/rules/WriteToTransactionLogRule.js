"use strict";
const RuleIF = require('./RulesIF');
const path = require('path');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');
const env = require('../../../../utility/environment/environmentManager');
env.initSync();
const HDB_TRANSACTION_LOG_PATH = path.join(env.getHdbBasePath(),'clustering', 'transaction_log');
const RotatingFileWriteStream = require('../../../../utility/fs/RotatingFileWriteStream');
const terms = require('../../../../utility/hdbTerms');
const RotatingFileWriteStreamOptionsObject = require('../../socketClusterObjects').RotatingFileWriteStreamOptionsObject;

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
                let log_filename = path.join(HDB_TRANSACTION_LOG_PATH, req.channel, req.channel);
                let audit_filename = path.join(HDB_TRANSACTION_LOG_PATH, req.channel, "audit.json");
                let options = new RotatingFileWriteStreamOptionsObject(log_filename, "custom", "50M", "10", audit_filename);

                this.transaction_stream = new RotatingFileWriteStream(options);
            }
        }catch(e){
            log.trace('unable to create transaction stream: ' + HDB_TRANSACTION_LOG_PATH + req.channel);
            log.error(e);
            return true;
        }

        try {
            let timestamp = (req.data && req.data.hdb_header && req.data.hdb_header.timestamp) ? req.data.hdb_header.timestamp : Date.now();
            let transaction_csv = timestamp + ',' + req.data.transaction.operation + ',';

            //using the JS native encodeURIComponent is 3x faster than using regex to replace special character like \t \n \r, etc...
            if(req.data.transaction.operation === terms.OPERATIONS_ENUM.INSERT || req.data.transaction.operation === terms.OPERATIONS_ENUM.UPDATE){
                transaction_csv += encodeURIComponent(JSON.stringify(req.data.transaction.records));
            } else if(req.data.transaction.operation === terms.OPERATIONS_ENUM.DELETE) {
                transaction_csv += encodeURIComponent(JSON.stringify(req.data.transaction.hash_values));
            }

            transaction_csv += LINE_DELIMITER;
            this.transaction_stream.write(transaction_csv);
        } catch(err) {
            log.trace('failed write to transaction log: ' + req.channel);
            log.error(err);
            return false;
        }
        return true;
    }
}
module.exports = WriteToTransactionLogRule;