'use strict';

const hdb_utils = require('../../../utility/common_utils');
const hdb_terms = require('../../../utility/hdbTerms');

module.exports = convertOperationToTransaction;

// This will be updated soon by Eli, hence the lack of unit tests
function convertOperationToTransaction(write_object, written_hashes, hash_attribute){
    if(global.hdb_socket_client !== undefined && write_object.schema !== 'system' && Array.isArray(written_hashes) && written_hashes.length > 0){
        let transaction = {
            operation: write_object.operation,
            schema: write_object.schema,
            table: write_object.table,
            records:[]
        };

        write_object.records.forEach(record =>{
            if(written_hashes.indexOf(hdb_utils.autoCast(record[hash_attribute])) >= 0) {
                transaction.records.push(record);
            }
        });
        let insert_msg = hdb_utils.getClusterMessage(hdb_terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
        insert_msg.transaction = transaction;
        hdb_utils.sendTransactionToSocketCluster(`${write_object.schema}:${write_object.table}`, insert_msg);
    }
}
