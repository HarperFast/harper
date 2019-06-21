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
        this.transaction_stream = undefined;
    }
    async evaluateRule(req, args, worker) {
        if(req.data.__transacted !== true){
            return;
        }

        log.trace('Evaluating write to transaction log rule');
        if(!req || !req.channel || !req.data) {
            log.error('Invalid request data, not writing to transaction log.');
            return true;
        }

        if(VALID_OPERATIONS.indexOf(req.data.operation) < 0){
            log.debug('Invalid operation, not writing to transaction log.');
            return true;
        }

        try {
            if(this.transaction_stream === undefined){
                this.transaction_stream = fs.createWriteStream(HDB_QUEUE_PATH + req.channel, {flags:'a'});
            }

            let transaction_csv = req.data.timestamp + ',' + req.data.__id + ',' + req.data.operation + ',';

            if(req.data.operation === 'insert' || req.data.operation === 'update'){
                transaction_csv += JSON.stringify(req.data.records, this.escape);
            } else if(req.data.operation === 'delete') {
                transaction_csv += JSON.stringify(req.data.hash_values, this.escape);
            }

            transaction_csv += LINE_DELIMITER;
            this.transaction_stream.write(transaction_csv);
        } catch(err) {
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