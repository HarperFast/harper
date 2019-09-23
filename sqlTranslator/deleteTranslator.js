const alasql = require('alasql');
const async = require('async');
const search = require('../data_layer/search');
const _delete = require('../data_layer/delete');
const hdb_util = require(`../utility/common_utils`);
const RECORD = 'record';
const SUCCESS = 'successfully deleted';

module.exports = {
    convertDelete:convertDelete
};

function generateReturnMessage(delete_results_object) {
    return `${delete_results_object.deleted_hashes.length} ${RECORD}${delete_results_object.deleted_hashes.length === 1 ? `` : `s`} ${SUCCESS}`;
}

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

        async.waterfall([
            search.search.bind(null, search_statement),
            _delete.deleteRecords.bind(null, from.databaseid, from.tableid),
        ], (err, result)=>{
            if(err){
                if(err.hdb_code){
                    return callback(null, err.message);
                }
                return callback(err);
            }

            if(hdb_util.isEmptyOrZeroLength(result.message)) {
                result.message = generateReturnMessage(result);
            }
            callback(null, result);
        });

    } catch(e){
        callback(e);
    }
}