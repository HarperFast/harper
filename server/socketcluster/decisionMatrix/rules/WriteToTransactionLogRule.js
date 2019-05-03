"use strict";
const RuleIF = require('./RulesIF');
const log = require('../../../../utility/logging/harper_logger');
const types = require('../../types');
const env = require('../../../../utility/environment/environmentManager');
env.initSync();
const HDB_QUEUE_PATH = env.getHdbBasePath() + '/schema/system/hdb_queue/';

const fs = require('fs-extra');
const json_csv_parser = require('json-2-csv');

const LINE_DELIMITER = '\r\n';
const INSERT_UPDATE_FIELDS = ['__id', 'timestamp', 'operation', 'schema', 'table', 'records'];
const DELETE_FIELDS = ['__id', 'timestamp', 'operation', 'schema', 'table', 'hash_values'];
const VALID_OPERATIONS = ['insert', 'update', 'delete'];

/**
 * This worker rule should be called after a request has passed all middleware and rules.  It will post a message to
 * the exchange on the <schema>:<table> room.
 */
class WriteToTransactionLogRule extends RuleIF {
    constructor() {
        super();
        this.setRuleOrder(types.COMMAND_EVAL_ORDER_ENUM.LOW);
        this.pending_transaction_stream = undefined;
        this.transaction_stream = undefined;
    }
    async evaluateRule(req, args, worker) {
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
            if(this.pending_transaction_stream === undefined){
                this.pending_transaction_stream = fs.createWriteStream(HDB_QUEUE_PATH + 'pending:' + req.channel, {flags:'a'});
            }

            if(this.transaction_stream === undefined){
                this.transaction_stream = fs.createWriteStream(HDB_QUEUE_PATH + req.channel, {flags:'a'});
            }


            let keys = [];
            if(req.data.operation === 'insert' || req.data.update === 'insert'){
                keys = INSERT_UPDATE_FIELDS;
            } else if(req.data.operation === 'delete') {
                keys = DELETE_FIELDS;
            }

            if(req.data.__transacted === true){
                let transaction_csv = await json_csv_parser.json2csvAsync(req.data, {prependHeader: false, keys: keys});
                transaction_csv += LINE_DELIMITER;
                this.transaction_stream.write(transaction_csv);

            } else {
                keys.push('error', 'status');
                let transaction_csv = await json_csv_parser.json2csvAsync(req.data, {prependHeader: false, keys: keys});
                transaction_csv += LINE_DELIMITER;
                this.pending_transaction_stream.write(transaction_csv);
            }
        } catch(err) {
            log.error(err);
            return false;
        }
        return true;
    }
}
module.exports = WriteToTransactionLogRule;