const search = require('../data_layer/search'),
    async = require('async'),
    global_schema = require('../utility/globalSchema'),
    write = require('./insert');

module.exports = {
    update: update
};

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
                callback(err);
                return;
            }

            callback(null, results);
        });
    });

}

function buildUpdateRecords(update_record, table_info, ids, callback){
    let records = [];
    ids.forEach((id)=>{
        let record = update_record;
        record[table_info.hash_attribute] = id;
        records.push(record);
    });

    callback(null, records);
}

function updateRecords(update_wrapper, records, callback){
    let update_object = {
        operation:'update',
        schema:update_wrapper.schema,
        table:update_wrapper.table,
        records:records
    };

    write.insert(update_object, (err, results)=>{
        if(err){
            callback(err);
            return;
        }

        callback(null, results);
    });
}