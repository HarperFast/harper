const alasql = require('alasql');
const async = require('async');
const search = require('../data_layer/search');
const _delete = require('../data_layer/delete');
const util = require('util');
const cb_delete_record = util.callbackify(_delete.delete);

const SUCCESS_MESSAGE = 'records successfully deleted';

module.exports = {
    convertDelete:convertDelete
};

function convertDelete(statement, callback){

    try{
        //convert this update statement to a search capable statement
        //use javascript destructuring to assign variables into from & where
        let {table: from, where} = statement;
        let search_statement = new alasql.yy.Select();
        let columns = [new alasql.yy.Column({columnid:'*', tableid: statement.table.tableid})];
        search_statement.columns = columns;
        search_statement.from = [from];
        search_statement.where = where;

        let delete_obj = {
            schema: from.databaseid,
            table: from.tableid,
        };

        async.waterfall([
            search.search.bind(null, search_statement),
            (records, callback) => {
                delete_obj.records = records;
                callback(null, delete_obj);
            },
            cb_delete_record
        ], (err)=>{
            if(err){
                if(err.hdb_code){
                    return callback(null, err.message);
                }
                return callback(err);
            }

            callback(null, SUCCESS_MESSAGE);
        });

    } catch(e){
        callback(e);
    }
}
