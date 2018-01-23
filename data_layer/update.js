const search = require('../data_layer/search'),
    async = require('async'),
    global_schema = require('../utility/globalSchema'),
    winston = require('../utility/logging/winston_logger'),
    write = require('./insert'),
    clone = require('clone'),
    alasql = require('alasql');

module.exports = {
    update: update
};

/**
 * Description
 * @method update
 * @param {} statement
 * @param {} callback
 * @return
 */
function update(statement, callback){
    global_schema.getTableSchema(statement.table.databaseid, statement.table.tableid, (err, table_info)=>{
        if(err){
            callback(err);
            return;
        }

        let update_record = createUpdateRecord(statement.columns);

        //convert this update statement to a search capable statement
        let {table: from, where} = statement;
        let table_clone = clone(from);
        let search_statement = new alasql.yy.Select();
        let columns = [new alasql.yy.Column({columnid:table_info.hash_attribute, tableid: statement.table.tableid})];
        search_statement.columns = columns;
        search_statement.from = [from];
        search_statement.where = where;

        async.waterfall([
            search.search.bind(null, search_statement),
            buildUpdateRecords.bind(null, update_record),
            updateRecords.bind(null, table_clone)
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

function createUpdateRecord(columns){
    let record = {};

    columns.forEach((column)=>{
        record[column.column.columnid] = column.expression.value ? column.expression.value : column.expression.columnid;
    });

    return record;
}

/**
 * Description
 * @method buildUpdateRecords
 * @param {} update_record
 * @param {} records
 * @param {} callback
 * @return
 */
function buildUpdateRecords(update_record, records, callback){
    if(!records || records.length === 0){
        return callback({hdb_code:1, message: "update statement found no records to update"});
    }

    let new_records = records.map((record)=>{
        return Object.assign(record, update_record);
    });

    callback(null, new_records);
}

/**
 * Description
 * @method updateRecords
 * @param {} table
 * @param {} records
 * @param {} callback
 * @return
 */
function updateRecords(table, records, callback){
    let update_object = {
        operation:'update',
        schema: table.databaseid,
        table: table.tableid,
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