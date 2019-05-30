"use strict";

const search = require('../data_layer/search');
const async = require('async');
const global_schema = require('../utility/globalSchema');
const logger = require('../utility/logging/harper_logger');
const write = require('./insert');
const clone = require('clone');
const alasql = require('alasql');
const util = require('util');
const cb_insert_update = util.callbackify(write.update);

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

/**
 * creates a json object based on the AST
 * @param columns
 */
function createUpdateRecord(columns){
    let record = {};

    columns.forEach((column)=>{
        //we want to check to validate that the value attribute exists on column.expression, if it doesn't we use the columnid
        record[column.column.columnid] = "value" in column.expression ? column.expression.value : column.expression.columnid;
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

    cb_insert_update(update_object, (err, res) => {
        if(err){
            callback(err);
            return;
        }

        callback(null, res);
    });
}