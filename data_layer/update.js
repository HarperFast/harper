const search = require('../data_layer/search'),
    async = require('async'),
    global_schema = require('../utility/globalSchema'),
    winston = require('../utility/logging/winston_logger'),
    write = require('./insert');

module.exports = {
    update: update
};

/**
 * Description
 * @method update
 * @param {} update_wrapper
 * @param {} callback
 * @return 
 */
function update(update_wrapper, callback){
    global_schema.getTableSchema(update_wrapper.schema, update_wrapper.table, (err, table_info)=>{
        if(err){
            callback(err);
            return;
        }

        async.waterfall([
            search.multiConditionSearch.bind(null,update_wrapper.conditions, table_info),
            buildUpdateRecords.bind(null, update_wrapper.record, table_info),
            updateRecords.bind(null, update_wrapper)
        ], (err, results)=>{
            if(err){
                if(err.hdb_code){
                    return callback(null, err.message);
                }
                return callback(err);
            }

            callback(null, results);
        });
    });

}

/**
 * Description
 * @method buildUpdateRecords
 * @param {} update_record
 * @param {} table_info
 * @param {} ids
 * @param {} callback
 * @return 
 */
function buildUpdateRecords(update_record, table_info, ids, callback){
    let records = [];
    if(!ids || ids.length === 0){
        return callback({hdb_code:1, message: "update statement found no records to update"});
    }

    ids.forEach((id)=>{
        let record = update_record;
        record[table_info.hash_attribute] = id;
        records.push(record);
    });

    callback(null, records);
}

/**
 * Description
 * @method updateRecords
 * @param {} update_wrapper
 * @param {} records
 * @param {} callback
 * @return 
 */
function updateRecords(update_wrapper, records, callback){
    let update_object = {
        operation:'update',
        schema:update_wrapper.schema,
        table:update_wrapper.table,
        records:records
    };

    write.update(update_object, (err, results)=>{
        if(err){
            callback(err);
            return;
        }

        callback(null, results);
    });
}