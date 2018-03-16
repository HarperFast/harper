const condition_parser = require('./conditionParser'),
    deleter = require('../data_layer/delete'),
    alasql = require('alasql'),
    async = require('async'),
    search = require('../data_layer/search'),
    _delete = require('../data_layer/delete');

module.exports = {
    convertDelete:convertDelete
};

function convertDelete(statement, callback){
    try{
        //convert this update statement to a search capable statement
        let {table: from, where} = statement;
        //let table_clone = clone(from);
        let search_statement = new alasql.yy.Select();
        let columns = [new alasql.yy.Column({columnid:'*', tableid: statement.table.tableid})];
        search_statement.columns = columns;
        search_statement.from = [from];
        search_statement.where = where;

        async.waterfall([
            search.search.bind(null, search_statement),
            buildDeleteObject,
            //updateRecords.bind(null, table_clone)
        ], (err, results)=>{
            if(err){
                if(err.hdb_code){
                    return callback(null, err.message);
                }
                return callback(err);
            }

            callback(null, results);
        });

    } catch(e){
        callback(e);
    }
}

function buildDeleteObject(delete_wrapper, results, callback){

    _delete.deleteRecords()
    console.log(results);
}