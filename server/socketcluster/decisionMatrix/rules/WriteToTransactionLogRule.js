"use strict";
const RuleIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');
const env = require('../../../../utility/environment/environmentManager');
env.initSync();
const HDB_QUEUE_PATH = env.getHdbBasePath() + '/schema/system/hdb_queue/';
const csvparse = require('papaparse');
const fs = require('fs-extra');

const LINE_DELIMITER = '\r\n';
const INSERT_UPDATE_FIELDS = ['__id', 'timestamp', 'operation', 'records'];
const DELETE_FIELDS = ['__id', 'timestamp', 'operation', 'hash_values'];
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

            let convert_object = {
                __id: req.data.__id,
                timestamp: req.data.timestamp,
                operation: req.data.operation
            };

            if(req.data.operation === 'insert' || req.data.operation === 'update'){
                convert_object.records = JSON.stringify(req.data.records);
            } else if(req.data.operation === 'delete') {
                convert_object.records = JSON.stringify(req.data.hash_values);
            }

            let transaction_csv = csvparse.unparse([convert_object], {header:false, columns:['timestamp', '__id', 'operation', 'records']});
            transaction_csv += LINE_DELIMITER;
            this.transaction_stream.write(transaction_csv);
        } catch(err) {
            log.error(err);
            return false;
        }
        return true;
    }

}
module.exports = WriteToTransactionLogRule;