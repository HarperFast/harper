"use strict";
const RuleIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');
const env = require('../../../../utility/environment/environmentManager');
env.initSync();
const HDB_QUEUE_PATH = env.getHdbBasePath() + '/clustering/transaction_log/';
const FileWriteStream = require('../../../../utility/fs/RotatingFileWriteStream');
const terms = require('../../../../utility/hdbTerms');

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
                this.transaction_stream = new FileWriteStream(HDB_QUEUE_PATH + req.channel, {flags: 'a', mode: terms.HDB_FILE_PERMISSIONS});
            }
        }catch(e){
            log.trace('unable to create transaction stream: ' + HDB_QUEUE_PATH + req.channel);
            log.error(e);
            return true;
        }

        try {
            let timestamp = (req.data && req.data.hdb_header && req.data.hdb_header.timestamp) ? req.data.hdb_header.timestamp : Date.now();
            let transaction_csv = timestamp + ',' + req.data.transaction.operation + ',';

            if(req.data.transaction.operation === terms.OPERATIONS_ENUM.INSERT || req.data.transaction.operation === terms.OPERATIONS_ENUM.UPDATE){
                transaction_csv += JSON.stringify(req.data.transaction.records, this.escape);
            } else if(req.data.transaction.operation === terms.OPERATIONS_ENUM.DELETE) {
                transaction_csv += JSON.stringify(req.data.transaction.hash_values, this.escape);
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

    /**
     * this function escapes special characters in a stringified json object.
     * in testing i found that when a json object has these special characters and is read from a file the JSON.parse fails because say \n
     * is a literal new line rather than the string version of it
     * @param key
     * @param val
     * @returns {string|*}
     */
    //TODO per https://harperdb.atlassian.net/browse/CORE-412 find a better way to do this escaping
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